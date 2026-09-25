// Postgres-backed SignatureStore plus the contract-app specific tables (the uploaded
// PDF and the final executed PDF). Schema is applied idempotently at boot.
import pg from "pg";
import type { AuditEvent, RequestStatus, SignatureRequest, SignatureStore, Signer } from "../types.ts";

export const SCHEMA_SQL = `
create table if not exists signature_requests (
  id              uuid primary key,
  title           text not null,
  document_html   text not null,
  document_sha256 text not null,
  created_at      timestamptz not null default now(),
  status          text not null check (status in ('pending', 'completed', 'voided')),
  metadata        jsonb
);
create table if not exists signature_signers (
  id                uuid primary key,
  request_id        uuid not null references signature_requests(id) on delete cascade,
  name              text not null,
  email             text not null,
  "order"           int not null,
  status            text not null check (status in ('pending', 'signed', 'declined')),
  signed_at         timestamptz,
  token_hash        text not null,
  token_expires_at  timestamptz not null,
  unique (request_id, "order")
);
create table if not exists signature_audit_events (
  id          uuid primary key,
  request_id  uuid not null references signature_requests(id) on delete cascade,
  signer_id   uuid not null references signature_signers(id) on delete cascade,
  type        text not null check (type in ('sent', 'viewed', 'signed', 'declined')),
  occurred_at timestamptz not null default now(),
  ip          text,
  user_agent  text,
  detail      jsonb
);
create table if not exists contract_documents (
  request_id   uuid primary key references signature_requests(id) on delete cascade,
  filename     text not null,
  pdf          bytea not null,
  pdf_sha256   text not null,
  signed_pdf   bytea,
  signed_sha256 text,
  completed_at timestamptz
);
create index if not exists signature_signers_request_id_idx on signature_signers(request_id);
create index if not exists signature_audit_events_request_id_idx on signature_audit_events(request_id);
`;

export interface ContractDocument {
  requestId: string;
  filename: string;
  pdf: Buffer;
  pdfSha256: string;
  signedPdf?: Buffer;
  signedSha256?: string;
  completedAt?: string;
}

export interface RequestSummary {
  id: string;
  title: string;
  createdAt: string;
  status: RequestStatus;
  signers: { name: string; email: string; order: number; status: string; signedAt?: string }[];
}

function toSigner(row: any): Signer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    order: row.order,
    status: row.status,
    signedAt: row.signed_at ? new Date(row.signed_at).toISOString() : undefined,
    tokenHash: row.token_hash,
    tokenExpiresAt: new Date(row.token_expires_at).toISOString(),
  };
}

export class PgStore implements SignatureStore {
  pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost") || databaseUrl.includes("railway.internal") ? undefined : { rejectUnauthorized: false },
    });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async createRequest(request: SignatureRequest): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into signature_requests (id, title, document_html, document_sha256, created_at, status, metadata)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [request.id, request.title, request.documentHtml, request.documentSha256, request.createdAt, request.status, request.metadata ?? null],
      );
      for (const s of request.signers) {
        await client.query(
          `insert into signature_signers (id, request_id, name, email, "order", status, signed_at, token_hash, token_expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [s.id, request.id, s.name, s.email, s.order, s.status, s.signedAt ?? null, s.tokenHash, s.tokenExpiresAt],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRequest(id: string): Promise<SignatureRequest | null> {
    const { rows } = await this.pool.query("select * from signature_requests where id = $1", [id]);
    const row = rows[0];
    if (!row) return null;
    const signers = await this.pool.query(`select * from signature_signers where request_id = $1 order by "order"`, [id]);
    return {
      id: row.id,
      title: row.title,
      documentHtml: row.document_html,
      documentSha256: row.document_sha256,
      createdAt: new Date(row.created_at).toISOString(),
      status: row.status,
      signers: signers.rows.map(toSigner),
      metadata: row.metadata ?? undefined,
    };
  }

  async updateSigner(_requestId: string, signerId: string, patch: Partial<Signer>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.status) add("status", patch.status);
    if (patch.signedAt) add("signed_at", patch.signedAt);
    if (patch.tokenHash) add("token_hash", patch.tokenHash);
    if (patch.tokenExpiresAt) add("token_expires_at", patch.tokenExpiresAt);
    if (sets.length === 0) return;
    values.push(signerId);
    await this.pool.query(`update signature_signers set ${sets.join(", ")} where id = $${values.length}`, values);
  }

  async updateRequestStatus(requestId: string, status: RequestStatus): Promise<void> {
    await this.pool.query("update signature_requests set status = $2 where id = $1", [requestId, status]);
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `insert into signature_audit_events (id, request_id, signer_id, type, occurred_at, ip, user_agent, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [event.id, event.requestId, event.signerId, event.type, event.occurredAt, event.ip ?? null, event.userAgent ?? null, event.detail ?? null],
    );
  }

  async listAuditEvents(requestId: string): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query(
      "select * from signature_audit_events where request_id = $1 order by occurred_at",
      [requestId],
    );
    return rows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      signerId: r.signer_id,
      type: r.type,
      occurredAt: new Date(r.occurred_at).toISOString(),
      ip: r.ip ?? undefined,
      userAgent: r.user_agent ?? undefined,
      detail: r.detail ?? undefined,
    }));
  }

  async listRequests(): Promise<RequestSummary[]> {
    const { rows } = await this.pool.query(
      `select r.id, r.title, r.created_at, r.status,
              coalesce(json_agg(json_build_object('name', s.name, 'email', s.email, 'order', s."order", 'status', s.status, 'signedAt', s.signed_at) order by s."order") filter (where s.id is not null), '[]') as signers
         from signature_requests r left join signature_signers s on s.request_id = r.id
        group by r.id order by r.created_at desc limit 200`,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: new Date(r.created_at).toISOString(),
      status: r.status,
      signers: r.signers,
    }));
  }

  async saveDocument(doc: { requestId: string; filename: string; pdf: Buffer; pdfSha256: string }): Promise<void> {
    await this.pool.query(
      "insert into contract_documents (request_id, filename, pdf, pdf_sha256) values ($1, $2, $3, $4)",
      [doc.requestId, doc.filename, doc.pdf, doc.pdfSha256],
    );
  }

  async getDocument(requestId: string): Promise<ContractDocument | null> {
    const { rows } = await this.pool.query("select * from contract_documents where request_id = $1", [requestId]);
    const r = rows[0];
    if (!r) return null;
    return {
      requestId: r.request_id,
      filename: r.filename,
      pdf: r.pdf,
      pdfSha256: r.pdf_sha256,
      signedPdf: r.signed_pdf ?? undefined,
      signedSha256: r.signed_sha256 ?? undefined,
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
    };
  }

  async saveSignedPdf(requestId: string, signedPdf: Buffer, signedSha256: string, completedAt: string): Promise<void> {
    await this.pool.query(
      "update contract_documents set signed_pdf = $2, signed_sha256 = $3, completed_at = $4 where request_id = $1",
      [requestId, signedPdf, signedSha256, completedAt],
    );
  }
}
