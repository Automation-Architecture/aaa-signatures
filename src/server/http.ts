import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

export function clientIp(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || undefined;
}

export function userAgent(req: IncomingMessage): string | undefined {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] : ua;
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, "upload too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface FormPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Minimal multipart/form-data parser: enough for a few text fields and one PDF. */
export function parseMultipart(body: Buffer, contentType: string): FormPart[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new HttpError(400, "malformed multipart body");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: FormPart[] = [];

  let position = body.indexOf(delimiter);
  while (position !== -1) {
    position += delimiter.length;
    if (body.subarray(position, position + 2).toString() === "--") break; // closing delimiter
    position += 2; // CRLF after the boundary line
    const headerEnd = body.indexOf("\r\n\r\n", position);
    if (headerEnd === -1) break;
    const headerText = body.subarray(position, headerEnd).toString("utf8");
    const next = body.indexOf(delimiter, headerEnd + 4);
    const dataEnd = next === -1 ? body.length : next - 2; // strip CRLF before the next boundary
    const data = body.subarray(headerEnd + 4, dataEnd);

    const disposition = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
    const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim();
    if (disposition) {
      parts.push({ name: disposition[1]!, filename: disposition[2], contentType: type, data });
    }
    position = next;
  }
  return parts;
}

export function parseForm(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body.toString("utf8"))) out[key] = value;
  return out;
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (req.headers.cookie ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) out[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return out;
}

const SESSION_COOKIE = "aaa_contract_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** A signed "who, until when" cookie. The identity is shown in the header and
 * recorded; a session can't outlive its expiry even if the cookie is kept. */
export function sessionValue(secret: string, email: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ e: email, x: expiresAt })).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function readSession(req: IncomingMessage, secret: string): { email: string } | null {
  const presented = parseCookies(req)[SESSION_COOKIE];
  if (!presented) return null;
  const [payload, signature] = presented.split(".");
  if (!payload || !signature || !constantTimeEqual(signature, sign(secret, payload))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof e !== "string" || typeof x !== "number" || x < Date.now()) return null;
    return { email: e };
  } catch {
    return null;
  }
}

export function setSessionCookie(res: ServerResponse, secret: string, secure: boolean, email: string): void {
  const value = sessionValue(secret, email, Date.now() + SESSION_TTL_SECONDS * 1000);
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
  res.appendHeader("Set-Cookie", `${SESSION_COOKIE}=${value}; ${flags}`);
}

export function clearSessionCookie(res: ServerResponse): void {
  res.appendHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
  res.end();
}
