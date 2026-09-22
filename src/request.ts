import { newId, generateToken, hashToken, hashDocument } from "./token.ts";
import type { SignatureRequest, SignatureStore, Signer } from "./types.ts";

export interface SignerInput {
  name: string;
  email: string;
}

export interface CreateRequestInput {
  title: string;
  documentHtml: string;
  /** Signing order: signers[0] signs first, then signers[1], etc. */
  signers: SignerInput[];
  expiresInDays?: number;
  metadata?: Record<string, string>;
}

export interface CreateRequestResult {
  request: SignatureRequest;
  /** Raw tokens, keyed by signer id. Only available here, at creation — embed
   * immediately in the invite link and never store these values. */
  rawTokens: Map<string, string>;
}

export async function createSignatureRequest(
  store: SignatureStore,
  input: CreateRequestInput,
): Promise<CreateRequestResult> {
  if (input.signers.length === 0) throw new Error("a signature request needs at least one signer");

  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.expiresInDays ?? 14) * 24 * 60 * 60 * 1000);
  const rawTokens = new Map<string, string>();

  const signers: Signer[] = input.signers.map((signer, order) => {
    const id = newId();
    const token = generateToken();
    rawTokens.set(id, token);
    return {
      id,
      name: signer.name,
      email: signer.email,
      order,
      status: "pending",
      tokenHash: hashToken(token),
      tokenExpiresAt: expiresAt.toISOString(),
    };
  });

  const request: SignatureRequest = {
    id: newId(),
    title: input.title,
    documentHtml: input.documentHtml,
    documentSha256: hashDocument(input.documentHtml),
    createdAt: now.toISOString(),
    status: "pending",
    signers,
    metadata: input.metadata,
  };

  await store.createRequest(request);
  return { request, rawTokens };
}

/** The signer, if any, who should be invited next: the lowest-order pending signer,
 * provided every signer before them has already signed. Returns undefined once the
 * request is fully signed, or if an earlier signer hasn't gone yet. */
export function nextSignerToInvite(request: SignatureRequest): Signer | undefined {
  const inOrder = [...request.signers].sort((a, b) => a.order - b.order);
  for (const signer of inOrder) {
    if (signer.status === "pending") return signer;
    if (signer.status !== "signed") return undefined;
  }
  return undefined;
}

/**
 * Mint a fresh token for a signer and return the raw value to embed in their invite
 * link. Needed for a second/third signer in a sequence: `createSignatureRequest`
 * only ever returns raw tokens once, at creation, and by the time an earlier signer
 * has finished — which is when a countersigner should actually be emailed — that
 * value is gone (only its hash was ever persisted). Call this right before sending
 * that signer's invite rather than trying to hold onto a token from creation time.
 */
export async function issueSignerToken(
  store: SignatureStore,
  requestId: string,
  signerId: string,
  expiresInDays = 14,
): Promise<string> {
  const token = generateToken();
  const tokenExpiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  await store.updateSigner(requestId, signerId, { tokenHash: hashToken(token), tokenExpiresAt });
  return token;
}
