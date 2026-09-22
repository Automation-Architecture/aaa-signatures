import { newId, verifyToken } from "./token.ts";
import { nextSignerToInvite } from "./request.ts";
import type { SignatureRequest, SignatureStore, Signer } from "./types.ts";

export type SigningErrorCode = "not_found" | "invalid_token" | "expired" | "not_your_turn" | "already_signed" | "voided";

export class SigningError extends Error {
  code: SigningErrorCode;
  constructor(code: SigningErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function findSigner(request: SignatureRequest, signerId: string): Signer {
  const signer = request.signers.find((s) => s.id === signerId);
  if (!signer) throw new SigningError("not_found", "no such signer on this request");
  return signer;
}

function checkTokenAndTurn(request: SignatureRequest, signer: Signer, token: string) {
  if (request.status === "voided") throw new SigningError("voided", "this request was voided");
  if (!verifyToken(token, signer.tokenHash)) throw new SigningError("invalid_token", "token does not match");
  if (new Date(signer.tokenExpiresAt).getTime() < Date.now()) throw new SigningError("expired", "signing link has expired");
  if (signer.status === "signed") throw new SigningError("already_signed", "already signed");

  const next = nextSignerToInvite(request);
  if (!next || next.id !== signer.id) throw new SigningError("not_your_turn", "an earlier signer hasn't signed yet");
}

/**
 * Load the document for display. A GET on the signing link must only ever call this —
 * it records a "viewed" audit event but never marks the document as signed. Corporate
 * mail-scanner sandboxes (Safe Links, Proofpoint, Mimecast) fetch links to detonate
 * them; if viewing and signing were the same action, a scanner would burn the
 * signature before the real recipient ever saw the page. See aaa-runbooks
 * integrations/mail-scanner-magic-link-consumption.md.
 */
export async function getSigningView(
  store: SignatureStore,
  input: { requestId: string; signerId: string; token: string; ip?: string; userAgent?: string },
): Promise<{ request: SignatureRequest; signer: Signer }> {
  const request = await store.getRequest(input.requestId);
  if (!request) throw new SigningError("not_found", "no such request");
  const signer = findSigner(request, input.signerId);
  checkTokenAndTurn(request, signer, input.token);

  await store.appendAuditEvent({
    id: newId(),
    requestId: request.id,
    signerId: signer.id,
    type: "viewed",
    occurredAt: new Date().toISOString(),
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { request, signer };
}

export interface CaptureSignatureInput {
  requestId: string;
  signerId: string;
  token: string;
  /** The signer's typed full legal name — the explicit act of intent, not a checkbox
   * alone. Required to be non-empty and is stored verbatim in the audit event. */
  typedLegalName: string;
  /** Explicit assent to the consent-to-electronic-records disclosure shown on the
   * signing page. Must be true; there is no default. */
  agreedToElectronicSignature: boolean;
  /** The documentSha256 the signing page rendered, echoed back by the client. If it
   * doesn't match what's on the request, the document changed since the page loaded
   * and the signature is refused rather than silently attached to a different text. */
  documentSha256Seen: string;
  ip?: string;
  userAgent?: string;
}

export interface CaptureSignatureResult {
  completed: boolean;
  nextSigner?: Signer;
}

export async function captureSignature(
  store: SignatureStore,
  input: CaptureSignatureInput,
): Promise<CaptureSignatureResult> {
  const request = await store.getRequest(input.requestId);
  if (!request) throw new SigningError("not_found", "no such request");
  const signer = findSigner(request, input.signerId);
  checkTokenAndTurn(request, signer, input.token);

  if (!input.agreedToElectronicSignature) {
    throw new Error("agreedToElectronicSignature must be true — do not call this from a page that didn't show the disclosure");
  }
  if (!input.typedLegalName.trim()) {
    throw new Error("typedLegalName is required — this is the recorded act of intent to sign");
  }
  if (input.documentSha256Seen !== request.documentSha256) {
    throw new Error("document hash mismatch — the signer saw a different document than what's on record; refusing to attach a signature to it");
  }

  const signedAt = new Date().toISOString();
  await store.updateSigner(request.id, signer.id, { status: "signed", signedAt });
  await store.appendAuditEvent({
    id: newId(),
    requestId: request.id,
    signerId: signer.id,
    type: "signed",
    occurredAt: signedAt,
    ip: input.ip,
    userAgent: input.userAgent,
    detail: { typedLegalName: input.typedLegalName, documentSha256: input.documentSha256Seen },
  });

  const updatedRequest: SignatureRequest = {
    ...request,
    signers: request.signers.map((s) => (s.id === signer.id ? { ...s, status: "signed", signedAt } : s)),
  };
  const next = nextSignerToInvite(updatedRequest);
  if (!next) {
    await store.updateRequestStatus(request.id, "completed");
    return { completed: true };
  }
  return { completed: false, nextSigner: next };
}
