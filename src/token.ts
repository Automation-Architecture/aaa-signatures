import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** A single-use signing token. Return this to the caller once, at creation time,
 * to embed in the invite link — never persist it in plaintext, only its hash. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time compare so token lookup can't be timed to leak the valid hash. */
export function verifyToken(token: string, tokenHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function hashDocument(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}
