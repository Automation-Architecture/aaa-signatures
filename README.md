# aaa-signatures

Self-hosted e-signature flow for AAA apps: non-embedded, identity-bound signature
requests with an ESIGN/UETA-oriented audit trail. Built to replace paying for a
per-seat e-signature vendor (Dropbox Sign, DocuSign, …) when a lightweight, correctly
designed flow covers the actual need.

Zero runtime dependencies in the core package — plain TypeScript run directly by
Node's built-in type stripping, no build step. Storage and email are pluggable
interfaces a consuming app wires up to whatever it already has (Supabase, plain
Postgres, Brevo, Resend, …); a reference Supabase adapter and Brevo email sender are
included.

## Why non-embedded

An earlier attempt at this (see `integrated-intelligence/ii-website` PR #19, closed
after review) used embedded signing behind a public endpoint that accepted a name and
email from whoever loaded the page. That lets anyone produce a "signed" document in
someone else's name — worse than no document, because the audit trail then makes the
forgery look legitimate.

This package only ever creates a signature request for a specific, named recipient,
triggered by an authenticated caller (an app's own admin action, or an agent acting on
someone's explicit instruction) — never from a public form. The recipient's identity is
established by **delivery to an email address the sender specified**, via a
single-use, expiring, unguessable token embedded in the invite link. The recipient
never types in who they are; the link already encodes it.

## What this gets you toward ESIGN/UETA, and what it doesn't

U.S. federal (ESIGN) and state (UETA) law don't require a specific vendor — they
require certain things be true of the process: consent to do business
electronically, clear intent to sign, the signature being attributable to the signer,
association between the signature and the record, and that the record stays
accessible/retainable. This package gives you the technical scaffolding for each:

| Requirement | How this package handles it |
|---|---|
| Consent to electronic records | The signing page must show a disclosure and the signer must explicitly agree (`agreedToElectronicSignature`) — there's no default, `captureSignature` rejects `false`. |
| Intent to sign | A typed full legal name (`typedLegalName`), not just a checkbox — mirrors how vendors' "type to sign" mode works. |
| Attribution to the signer | Single-use token delivered only to the address the sender specified; constant-time token verification; a strict signing-order check so a countersigner can't jump ahead. |
| Association with the record | `documentSha256` computed at request creation and re-checked at capture (`documentSha256Seen`) — a changed document is refused rather than silently signed. |
| Audit trail | `appendAuditEvent` records `sent`/`viewed`/`signed` with timestamp, IP, user agent — see `schema.sql` for making the underlying table append-only (no UPDATE/DELETE grant). |
| Retention | `renderSignedRecord` produces a final copy with the fingerprint and signature block; email it to every party once completed so retention doesn't depend on this system staying up. |

**What it does not give you:** a certified/insured vendor's legal indemnification, a
trusted third-party timestamp authority, or years of case law establishing the
provider's process holds up in a dispute. For a guest release or an internal consent
form, that gap doesn't matter much. **For client contracts and NDAs — real documents
with real dispute risk — get this design (or the actual disclosure/consent copy on the
signing page) reviewed by counsel before relying on it.** That's a one-time review, not
a blocker on building it.

## How it works

1. `createSignatureRequest(store, { title, documentHtml, signers })` — signers in
   signing order, index 0 first. Returns the request plus a `Map` of raw tokens
   (available only here; only the hash is persisted).
2. Build a signing URL per signer (`/sign/<requestId>/<signerId>?token=<rawToken>`,
   whatever routing the consuming app uses) and send the first signer's invite
   immediately with their creation-time token. For a second/third signer, don't hold
   onto their creation-time token waiting for their turn — call
   `issueSignerToken(store, requestId, signerId)` right before sending their invite
   (i.e. once `captureSignature` says it's their turn via `nextSigner`) to mint a
   fresh one. Only the hash is ever persisted, so the original token is gone by the
   time an earlier signer finishes. `inviteEmail` / `BrevoEmailSender` in
   `src/email.ts` are ready-made for actually sending it.
3. **GET the signing page → `getSigningView`.** This only renders the document and
   logs a `viewed` audit event. It must never sign anything — see the comment in
   `src/sign.ts` on why: corporate mail-scanner sandboxes (Microsoft Safe Links,
   Proofpoint, Mimecast) fetch links to detonate them, and if viewing were the same as
   signing, a scanner would burn the signature before the real recipient saw the page.
   (Full writeup: `aaa-runbooks` `integrations/mail-scanner-magic-link-consumption.md`.)
4. **POST the signing form → `captureSignature`.** Validates token, turn order,
   consent, typed name, and document hash, then records the signature. Returns
   `{ completed, nextSigner }` — if there's a next signer, send them their invite now.
5. Once `completed`, call `renderSignedRecord` and email it to everyone via
   `completedEmail`.

## Integration

- Storage: implement `SignatureStore` (see `src/types.ts`) against whatever DB the app
  already has. `src/adapters/supabase.ts` is a working reference — copy it in rather
  than depending on it, since it expects `@supabase/supabase-js` to already be a
  dependency of the consuming app. `schema.sql` is the reference Postgres shape.
- Email: implement `EmailSender`, or use `BrevoEmailSender` if the app is already on
  Brevo (matches the pattern in `integrated-intelligence/ii-website`
  `app/api/problem/route.ts`).
- The signing page itself (HTML form, disclosure copy, typed-name field) is the
  consuming app's UI — this package deliberately doesn't own presentation, since that's
  the part that varies per brand/app.

## Reference implementation

`integrated-intelligence/ii-website` — TIIS guest-release signing.

## Tests

```bash
node --experimental-strip-types --test tests/*.test.ts
```

Covers: view-never-signs, turn-order enforcement, wrong-token rejection, document-hash
mismatch refusal, the full two-signer happy path, and the no-consent rejection.

## Hosted app: contract.automationarchitecture.ai

`src/server/` is a small no-framework Node app on top of the library, deployed on Railway
(project `aaa-contract` in the `aaa_client_projects` workspace, Postgres alongside it).
Two signers only: the client and the operator.

- `/` password-protected upload page (title, PDF, client name and email, signing order),
  plus a list of every request with status.
- `/requests/<id>` status, audit trail, original and executed PDF downloads, resend link, void.
- `/sign/<requestId>/<signerId>?token=…` the signer's page: PDF inline, consent disclosure,
  typed legal name. GET only records a view; POST signs.
- On completion the original PDF gets a signature certificate page appended (`src/server/pdf.ts`)
  and is emailed to both parties as an attachment.

Environment: `DATABASE_URL`, `BASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `BREVO_API_KEY`,
`EMAIL_FROM_EMAIL`, `EMAIL_FROM_NAME`, `ADMIN_SIGNER_NAME`, `ADMIN_SIGNER_EMAIL`.
Run locally with `npm run dev` (reads `.env`); `npm start` runs the compiled `dist/`.
