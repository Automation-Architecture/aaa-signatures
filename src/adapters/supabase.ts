// Reference SignatureStore backed by Supabase, matching schema.sql. Not a hard
// dependency of the core package — copy this file into the consuming app (which
// already has @supabase/supabase-js and its own client setup) and adjust as needed.
//
// import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditEvent, RequestStatus, SignatureRequest, SignatureStore, Signer } from "../types.ts";

type SupabaseClientLike = {
  from(table: string): {
    insert(row: unknown): Promise<{ error: unknown }>;
    select(columns: string): { eq(column: string, value: unknown): Promise<{ data: unknown; error: unknown }> };
    update(patch: unknown): { eq(column: string, value: unknown): Promise<{ error: unknown }> };
  };
};

function toSignerRow(requestId: string, signer: Signer) {
  return {
    id: signer.id,
    request_id: requestId,
    name: signer.name,
    email: signer.email,
    order: signer.order,
    status: signer.status,
    signed_at: signer.signedAt ?? null,
    token_hash: signer.tokenHash,
    token_expires_at: signer.tokenExpiresAt,
  };
}

export class SupabaseSignatureStore implements SignatureStore {
  private client: SupabaseClientLike;
  constructor(client: SupabaseClientLike) {
    this.client = client;
  }

  async createRequest(request: SignatureRequest): Promise<void> {
    const { error: requestError } = await this.client.from("signature_requests").insert({
      id: request.id,
      title: request.title,
      document_html: request.documentHtml,
      document_sha256: request.documentSha256,
      created_at: request.createdAt,
      status: request.status,
      metadata: request.metadata ?? null,
    });
    if (requestError) throw requestError;

    const { error: signersError } = await this.client
      .from("signature_signers")
      .insert(request.signers.map((s) => toSignerRow(request.id, s)));
    if (signersError) throw signersError;
  }

  async getRequest(id: string): Promise<SignatureRequest | null> {
    const { data: requestRow, error: requestError } = await this.client
      .from("signature_requests")
      .select("*")
      .eq("id", id);
    if (requestError) throw requestError;
    const row = (requestRow as any[])?.[0];
    if (!row) return null;

    const { data: signerRows, error: signersError } = await this.client
      .from("signature_signers")
      .select("*")
      .eq("request_id", id);
    if (signersError) throw signersError;

    const signers: Signer[] = (signerRows as any[]).map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      order: s.order,
      status: s.status,
      signedAt: s.signed_at ?? undefined,
      tokenHash: s.token_hash,
      tokenExpiresAt: s.token_expires_at,
    }));

    return {
      id: row.id,
      title: row.title,
      documentHtml: row.document_html,
      documentSha256: row.document_sha256,
      createdAt: row.created_at,
      status: row.status,
      signers,
      metadata: row.metadata ?? undefined,
    };
  }

  async updateSigner(_requestId: string, signerId: string, patch: Partial<Signer>): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.status) row.status = patch.status;
    if (patch.signedAt) row.signed_at = patch.signedAt;
    const { error } = await this.client.from("signature_signers").update(row).eq("id", signerId);
    if (error) throw error;
  }

  async updateRequestStatus(requestId: string, status: RequestStatus): Promise<void> {
    const { error } = await this.client.from("signature_requests").update({ status }).eq("id", requestId);
    if (error) throw error;
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    const { error } = await this.client.from("signature_audit_events").insert({
      id: event.id,
      request_id: event.requestId,
      signer_id: event.signerId,
      type: event.type,
      occurred_at: event.occurredAt,
      ip: event.ip ?? null,
      user_agent: event.userAgent ?? null,
      detail: event.detail ?? null,
    });
    if (error) throw error;
  }
}
