// Google sign-in (OpenID Connect authorization-code flow with PKCE) for the admin
// side. Same policy as the other internal AAA tools: the consent screen is Internal to
// the workspace, the hd hint narrows the account picker, and access is decided by an
// explicit allowlist (brad@ by default), never by domain membership alone.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.ts";
import { constantTimeEqual, parseCookies } from "./http.ts";

const STATE_COOKIE = "aaa_contract_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;

export function redirectUri(): string {
  return `${config.baseUrl}/auth/google/callback`;
}

function sign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(`oauth:${payload}`).digest("base64url");
}

/** Start the flow: remember state + PKCE verifier in a short-lived signed cookie. */
export function beginGoogleLogin(res: ServerResponse, secure: boolean): string {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const payload = Buffer.from(JSON.stringify({ s: state, v: verifier, x: Date.now() + STATE_TTL_MS })).toString("base64url");
  res.appendHeader("Set-Cookie", `${STATE_COOKIE}=${payload}.${sign(payload)}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`);

  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    hd: config.google.hostedDomain,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export type GoogleLoginResult = { ok: true; email: string } | { ok: false; reason: string };

function readState(req: IncomingMessage): { s: string; v: string } | null {
  const raw = parseCookies(req)[STATE_COOKIE];
  const [payload, signature] = (raw ?? "").split(".");
  if (!payload || !signature || !constantTimeEqual(signature, sign(payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.x > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

/** Finish the flow: check state, exchange the code, validate the ID token's claims,
 * then apply the allowlist. The ID token comes straight from Google's token endpoint
 * over TLS, so per OIDC Core 3.1.3.7 its claims can be validated without a separate
 * signature check. */
export async function completeGoogleLogin(req: IncomingMessage, url: URL, res: ServerResponse): Promise<GoogleLoginResult> {
  res.appendHeader("Set-Cookie", `${STATE_COOKIE}=; Path=/auth/google; HttpOnly; Max-Age=0`);
  if (url.searchParams.get("error")) return { ok: false, reason: "Google sign-in was cancelled." };
  const saved = readState(req);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!saved || !code || !constantTimeEqual(state, saved.s)) {
    return { ok: false, reason: "That sign-in link expired or didn't match. Please try again." };
  }

  const response = await fetch(config.google.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
      code_verifier: saved.v,
    }),
  });
  if (!response.ok) {
    console.error(`[auth] Google token exchange failed: ${response.status} ${await response.text()}`);
    return { ok: false, reason: "Google sign-in failed. Please try again." };
  }
  const { id_token: idToken } = (await response.json()) as { id_token?: string };
  const claims = parseIdToken(idToken);
  if (!claims) return { ok: false, reason: "Google sign-in failed. Please try again." };

  const problem = checkClaims(claims);
  if (problem) {
    console.warn(`[auth] refused Google sign-in for ${String(claims.email)}: ${problem}`);
    return { ok: false, reason: `${String(claims.email ?? "That account")} isn't allowed to use this site.` };
  }
  return { ok: true, email: String(claims.email).toLowerCase() };
}

function parseIdToken(token: string | undefined): Record<string, unknown> | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function checkClaims(claims: Record<string, unknown>): string | null {
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return "wrong issuer";
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.google.clientId)) return "wrong audience";
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return "expired";
  if (claims.email_verified !== true) return "email not verified";
  if (claims.hd !== config.google.hostedDomain) return "not a workspace account";
  const email = String(claims.email ?? "").toLowerCase();
  if (!config.allowedEmails.includes(email)) return "not on the allowlist";
  return null;
}
