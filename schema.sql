-- Reference schema for a SignatureStore backed by Postgres (Supabase or plain PG).
-- Adjust table/role names to fit the consuming app's existing schema conventions;
-- what matters is the shape and, especially, the append-only grant on audit_events.

create table if not exists signature_requests (
  id             uuid primary key,
  title          text not null,
  document_html  text not null,
  document_sha256 text not null,
  created_at     timestamptz not null default now(),
  status         text not null check (status in ('pending', 'completed', 'voided')),
  metadata       jsonb
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
  ip          inet,
  user_agent  text,
  detail      jsonb
);

create index if not exists signature_signers_request_id_idx on signature_signers(request_id);
create index if not exists signature_audit_events_request_id_idx on signature_audit_events(request_id);

-- The audit trail is only evidence if it can't be edited after the fact. Revoke
-- UPDATE/DELETE from the app's normal DB role and grant only INSERT + SELECT; do
-- writes through a role that has no UPDATE/DELETE grant on this table at all, e.g.:
--
--   revoke update, delete on signature_audit_events from app_role;
--   grant insert, select on signature_audit_events to app_role;
--
-- In Supabase, do this via RLS + explicit grants rather than relying on default
-- table privileges, and keep it out of any migration a future "just clean this up"
-- pass might loosen.

-- If the app's role owns the table (common on Railway or a single-role Postgres),
-- REVOKE does not bind the owner. A trigger does:
--
--   create or replace function signature_audit_events_append_only() returns trigger
--   language plpgsql as $$ begin raise exception 'signature_audit_events is append-only: % is not allowed', tg_op; end; $$;
--   create trigger signature_audit_events_no_update_delete before update or delete on signature_audit_events
--     for each row execute function signature_audit_events_append_only();
--   create trigger signature_audit_events_no_truncate before truncate on signature_audit_events
--     for each statement execute function signature_audit_events_append_only();
