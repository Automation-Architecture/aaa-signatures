// Core types for a signature request. Kept storage-agnostic on purpose: a consuming
// app supplies a SignatureStore backed by whatever database it already has (Supabase,
// plain Postgres, SQLite) rather than this package owning a client library.

export type SignerStatus = "pending" | "signed" | "declined";
export type RequestStatus = "pending" | "completed" | "voided";
export type AuditEventType = "sent" | "viewed" | "signed" | "declined";

export interface Signer {
  id: string;
  name: string;
  email: string;
  /** 0-based signing order. Signer 0 must sign before signer 1 can, and so on. */
  order: number;
  status: SignerStatus;
  signedAt?: string; // ISO 8601, UTC
  /** SHA-256 of the raw token. The raw token itself is never persisted. */
  tokenHash: string;
  tokenExpiresAt: string; // ISO 8601, UTC
}

export interface SignatureRequest {
  id: string;
  title: string;
  /** The exact HTML shown to signers. This is what documentSha256 is computed over. */
  documentHtml: string;
  documentSha256: string;
  createdAt: string; // ISO 8601, UTC
  status: RequestStatus;
  signers: Signer[];
  metadata?: Record<string, string>;
}

export interface AuditEvent {
  id: string;
  requestId: string;
  signerId: string;
  type: AuditEventType;
  occurredAt: string; // ISO 8601, UTC, server clock
  ip?: string;
  userAgent?: string;
  detail?: Record<string, unknown>;
}

/**
 * Storage the consuming app provides. audit_events MUST be append-only in the
 * underlying table (no UPDATE/DELETE grants on that table for the app role) — the
 * audit trail is only worth anything if it cannot be edited after the fact.
 */
export interface SignatureStore {
  createRequest(request: SignatureRequest): Promise<void>;
  getRequest(id: string): Promise<SignatureRequest | null>;
  /**
   * Apply a patch to one signer. When `patch.status` is "signed", this MUST be a
   * conditional update that only succeeds if the signer is still "pending" (for
   * example `... where id = $1 and status = 'pending'`), and MUST throw
   * `SigningError("already_signed")` if no row changed. That check is what stops two
   * concurrent submissions of the same signing form from both recording a signature;
   * captureSignature's own read-then-write check cannot close that race by itself.
   */
  updateSigner(requestId: string, signerId: string, patch: Partial<Signer>): Promise<void>;
  updateRequestStatus(requestId: string, status: RequestStatus): Promise<void>;
  appendAuditEvent(event: AuditEvent): Promise<void>;
}

export interface EmailSender {
  send(input: { to: { email: string; name: string }; subject: string; html: string; text: string }): Promise<void>;
}
