// contracts.automationarchitecture.ai: upload a PDF, send it to a client and the operator
// for sequential signature, then deliver the executed PDF with a signature certificate.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { config, googleEnabled, apiEnabled } from "./config.ts";
import { beginGoogleLogin, completeGoogleLogin } from "./google.ts";
import { PgStore, MAX_DELIVERY_ATTEMPTS, type RequestView } from "./store.ts";
import { validateContractUpload, formField, idempotencyMismatches, type ContractUpload } from "./intake.ts";
import { buildSignedPdf } from "./pdf.ts";
import * as pages from "./pages.ts";
import {
  HttpError, clientIp, userAgent, readBody, parseMultipart, parseForm, readSession, setSessionCookie,
  clearSessionCookie, constantTimeEqual, html, redirect, json, bearerTokenMatches,
} from "./http.ts";
import { createSignatureRequest, issueSignerToken, nextSignerToInvite } from "../request.ts";
import { getSigningView, captureSignature, SigningError } from "../sign.ts";
import { verifyToken, newId } from "../token.ts";
import { inviteEmail, completedEmail } from "./emails.ts";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { createRequire } from "node:module";
import type { SignatureRequest, SignatureStore, Signer } from "../types.ts";

const store = new PgStore(config.databaseUrl);
const secure = config.baseUrl.startsWith("https://");

// ---- email -------------------------------------------------------------------------

interface Attachment { name: string; content: Buffer }

// Sent from the Google Workspace mailbox that owns the contract@ alias, so the sent
// copy lands in that mailbox and replies thread there. No third party sees the contract.
const transport = config.smtp.user && config.smtp.password
  ? nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.password },
    })
  : null;

async function sendEmail(input: { to: { email: string; name: string }; subject: string; html: string; text: string; attachments?: Attachment[] }) {
  // Log-only mode wins even when SMTP credentials are present, so a developer with
  // real credentials in .env can't send live signing links by accident.
  if (config.emailDevLog) {
    console.warn(`[email] EMAIL_DEV_LOG: would have sent "${input.subject}" to ${input.to.email}\n${input.text}`);
    return;
  }
  if (!transport) {
    throw new Error("email is not configured: set SMTP_USER and SMTP_PASSWORD (or EMAIL_DEV_LOG=1 for local development)");
  }
  await transport.sendMail({
    from: { name: config.emailFrom.name, address: config.emailFrom.email },
    to: { name: input.to.name, address: input.to.email },
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments?.map((a) => ({ filename: a.name, content: a.content, contentType: "application/pdf" })),
  });
}

function signingUrl(request: SignatureRequest, signer: Signer, token: string) {
  return `${config.baseUrl}/sign/${request.id}/${signer.id}?token=${encodeURIComponent(token)}`;
}

/** The invite email went out, but recording the "sent" audit event failed afterwards.
 * Callers must not treat this as an unsent invite: re-sending would email a duplicate. */
class AuditWriteError extends Error {}

async function sendInvite(request: SignatureRequest, signer: Signer, token: string, isCountersigner: boolean, req?: IncomingMessage) {
  const message = inviteEmail({ baseUrl: config.baseUrl, signerName: signer.name, requestTitle: request.title, signingUrl: signingUrl(request, signer, token), isCountersigner, expiresInDays: config.linkExpiresInDays });
  await sendEmail({ to: { email: signer.email, name: signer.name }, ...message });
  try {
    await store.appendAuditEvent({
      id: newId(), requestId: request.id, signerId: signer.id, type: "sent", occurredAt: new Date().toISOString(),
      ip: req ? clientIp(req) : undefined, userAgent: req ? userAgent(req) : undefined, detail: { to: signer.email, isCountersigner },
    });
  } catch (error) {
    throw new AuditWriteError(`invite emailed to ${signer.email}, but the audit event could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Build and store the executed PDF if it doesn't exist yet. Safe to call again: an
 * existing executed PDF is reused, so its bytes and fingerprint never change. */
async function ensureSignedPdf(requestId: string) {
  const request = await store.getRequest(requestId);
  const doc = await store.getDocumentMeta(requestId);
  if (!request || !doc) throw new Error("request or document missing at completion");
  if (request.status !== "completed") throw new Error("request is not completed");
  if (doc.hasSignedPdf && doc.signedSha256) {
    const existing = await store.getPdf(requestId, "signed");
    if (existing) return { request, doc, signedPdf: existing, signedSha256: doc.signedSha256 };
  }
  const originalPdf = await store.getPdf(requestId, "original");
  if (!originalPdf) throw new Error("original PDF missing at completion");

  // The contract completed when the last party signed, not when this PDF happens to
  // be generated (which can be later, on a retry).
  const completedAt = request.signers.map((s) => s.signedAt).filter((v): v is string => Boolean(v)).sort().at(-1);
  if (!completedAt) throw new Error("completed request has no signing time");
  const events = await store.listAuditEvents(requestId);
  const signedPdf = await buildSignedPdf({ originalPdf, request, auditEvents: events, pdfSha256: doc.pdfSha256, completedAt });
  const signedSha256 = createHash("sha256").update(signedPdf).digest("hex");
  // Only the first writer's PDF is kept. A concurrent builder loses the conditional
  // write and uses the stored copy, so every signer gets identical bytes.
  if (await store.saveSignedPdfIfAbsent(requestId, signedPdf, signedSha256, completedAt)) {
    return { request, doc, signedPdf, signedSha256 };
  }
  const [stored, storedPdf] = await Promise.all([store.getDocumentMeta(requestId), store.getPdf(requestId, "signed")]);
  if (!stored?.signedSha256 || !storedPdf) throw new Error("executed PDF vanished after a concurrent save");
  return { request, doc: stored, signedPdf: storedPdf, signedSha256: stored.signedSha256 };
}

type CompletionResult = { status: "busy" } | { status: "done"; failed: string[] };

/**
 * Deliver the executed PDF to every signer who hasn't received it yet (or to every
 * signer when `force` is set, for the admin's "Resend" button). Delivery state is
 * persisted per signer, so a failure is retried by the background worker instead of
 * being lost in a log line.
 *
 * Only one finalization per request runs at a time, across every app instance: a
 * lease row in the database (expiring, so a crash can't wedge it). A caller that
 * finds the lease taken gets "busy", never a false success.
 */
async function sendCompletionEmails(requestId: string, opts: { force?: boolean } = {}): Promise<CompletionResult> {
  const lease = await store.acquireFinalizeLease(requestId);
  if (!lease) return { status: "busy" };
  try {
    const request = await store.getRequest(requestId);
    if (!request) throw new Error("no such request");
    await store.ensureDeliveries(requestId, request.signers.map((s) => s.id));
    if (opts.force) await store.resetDeliveries(requestId);
    const pending = new Set(
      (await store.listDeliveries(requestId)).filter((d) => !d.deliveredAt).map((d) => d.signerId),
    );
    if (pending.size === 0) return { status: "done", failed: [] };

    let built: Awaited<ReturnType<typeof ensureSignedPdf>>;
    try {
      built = await ensureSignedPdf(requestId);
    } catch (error) {
      const message = `could not build executed PDF: ${error instanceof Error ? error.message : String(error)}`;
      for (const signerId of pending) await store.recordDelivery(requestId, signerId, message);
      throw error;
    }
    const { doc, signedPdf, signedSha256 } = built;
    const filename = doc.filename.replace(/\.pdf$/i, "") + " (signed).pdf";
    const failed: string[] = [];
    for (const signer of request.signers.filter((s) => pending.has(s.id))) {
      const { subject, html: body, text } = completedEmail({ baseUrl: config.baseUrl, signerName: signer.name, requestTitle: request.title, signedSha256 });
      try {
        await sendEmail({ to: { email: signer.email, name: signer.name }, subject, html: body, text, attachments: [{ name: filename, content: signedPdf }] });
        await store.recordDelivery(requestId, signer.id);
      } catch (error) {
        console.error(`[email] completion email to ${signer.email} failed`, error);
        await store.recordDelivery(requestId, signer.id, error instanceof Error ? error.message : String(error));
        failed.push(signer.email);
      }
    }
    return { status: "done", failed };
  } finally {
    await store.releaseFinalizeLease(requestId, lease);
  }
}

/** Background retry for completion deliveries that failed. */
async function retryDueDeliveries() {
  try {
    for (const requestId of await store.listDueDeliveries()) {
      try {
        const result = await sendCompletionEmails(requestId);
        if (result.status === "busy") continue; // another instance or request owns it right now
        console.log(`[retry] request ${requestId}: ${result.failed.length ? `still failing for ${result.failed.join(", ")}` : "delivered"}`);
      } catch (error) {
        console.error(`[retry] request ${requestId} finalization failed`, error);
      }
    }
  } catch (error) {
    console.error("[retry] could not list due deliveries", error);
  }
}

// ---- routing -----------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void>;
const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

// Ids come from randomUUID() (lowercase). A strict shape keeps malformed ids like 36
// hyphens away from Postgres's uuid columns, where they would error instead of 404.
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  const session = readSession(req, config.sessionSecret);
  // Re-check the allowlist on every request, so removing an address from
  // ALLOWED_EMAILS ends that person's existing sessions too.
  if (session && (session.email === "password" ? !googleEnabled : config.allowedEmails.includes(session.email))) return true;
  html(res, 200, pages.loginPage({ google: googleEnabled }));
  return false;
}

// Admin: dashboard + upload
const PAGE_SIZE = 25;
route("GET", /^\/$/, async (req, res, _p, url) => {
  if (!requireAdmin(req, res)) return;
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const requested = Number(url.searchParams.get("page"));
  const page = Number.isFinite(requested) ? Math.min(100_000, Math.max(1, Math.floor(requested))) : 1;
  const list = await store.listRequests({
    q, view: (url.searchParams.get("view") ?? "all") as RequestView, adminEmail: config.adminSigner.email,
    limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
  });
  const lastPage = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  if (page > lastPage) {
    // An old or hand-edited link past the end: go to the last page that has results.
    url.searchParams.set("page", String(lastPage));
    if (lastPage === 1) url.searchParams.delete("page");
    redirect(res, `/${url.searchParams.size ? `?${url.searchParams}` : ""}#contracts`);
    return;
  }
  html(res, 200, pages.adminPage({ list, q, page, pageSize: PAGE_SIZE, adminSigner: config.adminSigner, notice: url.searchParams.get("notice") ?? undefined, error: url.searchParams.get("error") ?? undefined }));
});

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
route("GET", /^\/auth\/google$/, async (_req, res) => {
  if (!googleEnabled) throw new HttpError(404, "Google sign-in is not configured");
  redirect(res, beginGoogleLogin(res, secure));
});

route("GET", /^\/auth\/google\/callback$/, async (req, res, _p, url) => {
  if (!googleEnabled) throw new HttpError(404, "Google sign-in is not configured");
  const result = await completeGoogleLogin(req, url, res);
  if (!result.ok) {
    html(res, 403, pages.loginPage({ google: true, error: result.reason }));
    return;
  }
  console.log(`[auth] signed in ${result.email}`);
  setSessionCookie(res, config.sessionSecret, secure, result.email);
  redirect(res, "/");
});

// Password login only exists until Google sign-in is configured.
route("POST", /^\/login$/, async (req, res) => {
  if (googleEnabled) throw new HttpError(404, "password sign-in is disabled");
  const ip = clientIp(req) ?? "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.resetAt > now && attempt.count >= 10) {
    html(res, 429, pages.loginPage({ google: false, error: "Too many attempts. Try again in 15 minutes." }));
    return;
  }
  const form = parseForm(await readBody(req, 4096));
  if (constantTimeEqual(form.password ?? "", config.adminPassword)) {
    loginAttempts.delete(ip);
    setSessionCookie(res, config.sessionSecret, secure, "password");
    redirect(res, "/");
    return;
  }
  loginAttempts.set(ip, { count: (attempt && attempt.resetAt > now ? attempt.count : 0) + 1, resetAt: now + 15 * 60 * 1000 });
  html(res, 401, pages.loginPage({ google: false, error: "Wrong password." }));
});

route("POST", /^\/logout$/, async (_req, res) => {
  clearSessionCookie(res);
  redirect(res, "/");
});

/**
 * Create a signature request from a validated upload and email the first signer.
 * Shared by the admin form and the API. The request exists even if the invite email
 * fails; `inviteError` says so, and "Resend link" on the contract page recovers it.
 * `auditWarning` means the email did go out but its audit event wasn't recorded.
 */
async function createAndSend(upload: ContractUpload, via: "web" | "api", req: IncomingMessage) {
  const client = { name: upload.clientName, email: upload.clientEmail };
  const me = config.adminSigner;
  const signers = upload.order === "me_first" ? [me, client] : [client, me];

  // documentHtml is what the library fingerprints; binding the PDF's own hash and the
  // parties into it means the record fingerprint changes if any of those change.
  const documentHtml = `<p>Contract: ${pages.esc(upload.title)}</p><p>File: ${pages.esc(upload.filename)}</p><p>PDF SHA-256: ${upload.pdfSha256}</p>` +
    `<p>Parties: ${signers.map((s) => `${pages.esc(s.name)} &lt;${pages.esc(s.email)}&gt;`).join("; ")}</p>`;

  // The request, its signers and the PDF commit in one transaction: a request that exists
  // without its document would hold its idempotency key and fail every retry.
  const document = { filename: upload.filename, pdf: upload.pdf, pdfSha256: upload.pdfSha256 };
  const storeWithDocument: SignatureStore = {
    createRequest: (r) => store.createRequest(r, document),
    getRequest: (id) => store.getRequest(id),
    updateSigner: (requestId, signerId, patch) => store.updateSigner(requestId, signerId, patch),
    updateRequestStatus: (requestId, status) => store.updateRequestStatus(requestId, status),
    appendAuditEvent: (event) => store.appendAuditEvent(event),
  };
  const { request, rawTokens } = await createSignatureRequest(storeWithDocument, {
    title: upload.title, documentHtml, signers, expiresInDays: config.linkExpiresInDays,
    metadata: {
      filename: upload.filename, pdfSha256: upload.pdfSha256, order: upload.order, createdVia: via,
      ...(upload.idempotencyKey ? { idempotencyKey: upload.idempotencyKey } : {}),
    },
  });

  const first = request.signers.find((s) => s.order === 0)!;
  let inviteError: string | undefined;
  let auditWarning: string | undefined;
  try {
    await sendInvite(request, first, rawTokens.get(first.id)!, false, req);
  } catch (error) {
    if (error instanceof AuditWriteError) {
      console.error("[audit]", error.message);
      auditWarning = error.message;
    } else {
      console.error("[email] invite failed", error);
      inviteError = error instanceof Error ? error.message : String(error);
    }
  }
  return { request, first, inviteError, auditWarning };
}

route("POST", /^\/requests$/, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req, config.maxUploadBytes);
  const intake = await validateContractUpload(parseMultipart(body, String(req.headers["content-type"] ?? "")));
  if (!intake.ok) {
    redirect(res, `/?error=${encodeURIComponent(intake.error)}`);
    return;
  }
  const { request, first, inviteError, auditWarning } = await createAndSend(intake.upload, "web", req);
  if (inviteError) {
    redirect(res, `/requests/${request.id}?error=${encodeURIComponent("Request created but the invite email failed to send. Use Resend link.")}`);
    return;
  }
  if (auditWarning) {
    redirect(res, `/requests/${request.id}?error=${encodeURIComponent(`Sent to ${first.email}, but the "sent" audit event could not be recorded. Don't resend.`)}`);
    return;
  }
  redirect(res, `/requests/${request.id}?notice=${encodeURIComponent(`Sent to ${first.name} (${first.email}).`)}`);
});

route("GET", new RegExp(`^/requests/${UUID}$`), async (req, res, [id], url) => {
  if (!requireAdmin(req, res)) return;
  const request = await store.getRequest(id!);
  const doc = await store.getDocumentMeta(id!);
  if (!request || !doc) throw new HttpError(404, "no such request");
  const events = await store.listAuditEvents(id!);
  const deliveries = await store.listDeliveries(id!);
  html(res, 200, pages.requestDetailPage({
    request, events, deliveries, filename: doc.filename, pdfSha256: doc.pdfSha256, hasSigned: doc.hasSignedPdf,
    notice: url.searchParams.get("notice") ?? undefined, error: url.searchParams.get("error") ?? undefined,
  }));
});

route("GET", new RegExp(`^/requests/${UUID}/(original|signed)\\.pdf$`), async (req, res, [id, which]) => {
  if (!requireAdmin(req, res)) return;
  const doc = await store.getDocumentMeta(id!);
  if (!doc) throw new HttpError(404, "no such request");
  const bytes = await store.getPdf(id!, which === "signed" ? "signed" : "original");
  if (!bytes) throw new HttpError(404, "not signed yet");
  const name = which === "signed" ? doc.filename.replace(/\.pdf$/i, "") + " (signed).pdf" : doc.filename;
  res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`, "Cache-Control": "no-store" });
  res.end(bytes);
});

route("POST", new RegExp(`^/requests/${UUID}/resend$`), async (req, res, [id]) => {
  if (!requireAdmin(req, res)) return;
  const form = parseForm(await readBody(req, 4096));
  const request = await store.getRequest(id!);
  if (!request) throw new HttpError(404, "no such request");
  const next = nextSignerToInvite(request);
  if (!next || next.id !== form.signerId) {
    redirect(res, `/requests/${id}?error=${encodeURIComponent("That signer is not the one whose turn it is.")}`);
    return;
  }
  const token = await issueSignerToken(store, request.id, next.id, config.linkExpiresInDays);
  await sendInvite(request, next, token, next.order > 0, req);
  redirect(res, `/requests/${id}?notice=${encodeURIComponent(`New link sent to ${next.email}. Older links no longer work.`)}`);
});

route("POST", new RegExp(`^/requests/${UUID}/finalize$`), async (req, res, [id]) => {
  if (!requireAdmin(req, res)) return;
  const request = await store.getRequest(id!);
  if (!request) throw new HttpError(404, "no such request");
  if (request.status !== "completed") {
    redirect(res, `/requests/${id}?error=${encodeURIComponent("Not every party has signed yet.")}`);
    return;
  }
  try {
    const result = await sendCompletionEmails(id!, { force: true });
    if (result.status === "busy") {
      redirect(res, `/requests/${id}?error=${encodeURIComponent("The executed PDF is being sent right now. Refresh in a minute to see the result, then resend if needed.")}`);
      return;
    }
    const failed = result.failed;
    const query = failed.length ? `error=${encodeURIComponent(`Executed PDF ready, but email failed for ${failed.join(", ")}.`)}` : `notice=${encodeURIComponent("Executed PDF sent to both parties.")}`;
    redirect(res, `/requests/${id}?${query}`);
  } catch (error) {
    console.error(`[finalize] retry for ${id} failed`, error);
    redirect(res, `/requests/${id}?error=${encodeURIComponent(`Could not build the executed PDF: ${error instanceof Error ? error.message : "unknown error"}`)}`);
  }
});

route("POST", new RegExp(`^/requests/${UUID}/void$`), async (req, res, [id]) => {
  if (!requireAdmin(req, res)) return;
  const request = await store.getRequest(id!);
  if (!request) throw new HttpError(404, "no such request");
  if (request.status === "pending") await store.updateRequestStatus(id!, "voided");
  redirect(res, `/requests/${id}?notice=${encodeURIComponent("Request voided.")}`);
});

// Signer-facing
function signingErrorMessage(error: SigningError): string {
  switch (error.code) {
    case "expired": return "This signing link has expired. Please ask Automation Architecture AI to send a new one.";
    case "already_signed": return "You have already signed this document.";
    case "not_your_turn": return "This document is waiting on another party first. You will get an email when it is your turn.";
    case "voided": return "This signature request has been withdrawn.";
    default: return "This signing link is not valid.";
  }
}

route("GET", new RegExp(`^/sign/${UUID}/${UUID}$`), async (req, res, [requestId, signerId], url) => {
  const token = url.searchParams.get("token") ?? "";
  try {
    const { request, signer } = await getSigningView(store, { requestId: requestId!, signerId: signerId!, token, ip: clientIp(req), userAgent: userAgent(req) });
    const otherParty = request.signers.find((s) => s.id !== signer.id);
    const docUrl = `/sign/${request.id}/${signer.id}/document.pdf?token=${encodeURIComponent(token)}`;
    html(res, 200, pages.signingPage({ request, signer, token, docUrl, otherParty, pdfjsBase: PDFJS_BASE, error: url.searchParams.get("error") ?? undefined }));
  } catch (error) {
    if (error instanceof SigningError) { html(res, 403, pages.messagePage("Cannot open this document", signingErrorMessage(error))); return; }
    throw error;
  }
});

// The PDF itself. Token-gated but does not log a view (the page GET already did).
route("GET", new RegExp(`^/sign/${UUID}/${UUID}/document\\.pdf$`), async (_req, res, [requestId, signerId], url) => {
  const token = url.searchParams.get("token") ?? "";
  const request = await store.getRequest(requestId!);
  const signer = request?.signers.find((s) => s.id === signerId);
  if (!request || !signer || !verifyToken(token, signer.tokenHash)) throw new HttpError(403, "not allowed");
  // Same rules as the signing page: a link stops working once the request is voided,
  // the token expires, the signer has signed, or it isn't their turn.
  if (request.status !== "pending" || signer.status !== "pending" || new Date(signer.tokenExpiresAt).getTime() < Date.now()) {
    throw new HttpError(403, "this link is no longer valid");
  }
  if (nextSignerToInvite(request)?.id !== signer.id) throw new HttpError(403, "this link is no longer valid");
  const [doc, pdf] = await Promise.all([store.getDocumentMeta(request.id), store.getPdf(request.id, "original")]);
  if (!doc || !pdf) throw new HttpError(404, "missing document");
  res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`, "Cache-Control": "no-store", "X-Frame-Options": "SAMEORIGIN" });
  res.end(pdf);
});

route("POST", new RegExp(`^/sign/${UUID}/${UUID}$`), async (req, res, [requestId, signerId]) => {
  const form = parseForm(await readBody(req, 8192));
  const back = `/sign/${requestId}/${signerId}?token=${encodeURIComponent(form.token ?? "")}`;
  try {
    const result = await captureSignature(store, {
      requestId: requestId!, signerId: signerId!, token: form.token ?? "",
      typedLegalName: form.typedLegalName ?? "", agreedToElectronicSignature: form.agree === "yes",
      documentSha256Seen: form.documentSha256Seen ?? "", ip: clientIp(req), userAgent: userAgent(req),
    });
    const request = (await store.getRequest(requestId!))!;
    let finalized = true;
    if (result.completed) {
      try {
        const outcome = await sendCompletionEmails(request.id);
        // "busy" means another caller owns delivery and will record its outcome.
        finalized = outcome.status === "busy" || outcome.failed.length === 0;
      } catch (error) {
        finalized = false;
        console.error(`[finalize] request ${request.id} signed but finalization failed; use "Finalize and send" on the admin page`, error);
      }
    } else if (result.nextSigner) {
      const token = await issueSignerToken(store, request.id, result.nextSigner.id, config.linkExpiresInDays);
      try { await sendInvite(request, result.nextSigner, token, true); } catch (error) { console.error("[email] countersign invite failed", error); }
    }
    html(res, 200, pages.signedThanksPage({ request, completed: result.completed, nextSigner: result.nextSigner, finalized }));
  } catch (error) {
    if (error instanceof SigningError) { html(res, 403, pages.messagePage("Cannot sign this document", signingErrorMessage(error))); return; }
    const message = error instanceof Error ? error.message : "unknown error";
    if (/agreedToElectronicSignature|typedLegalName|hash mismatch/.test(message)) {
      redirect(res, `${back}&error=${encodeURIComponent(message.includes("hash") ? "The document changed since you loaded this page. Please reload and try again." : "Please tick the consent box and type your full legal name.")}`);
      return;
    }
    throw error;
  }
});

const brandMark = readFileSync(new URL("../../assets/mark.png", import.meta.url));

// PDF.js for the signing page, served from this app so a client's signing page never
// depends on a third-party CDN. The version is in the path, so it can be cached forever.
const requireModule = createRequire(import.meta.url);
const PDFJS_VERSION = String(requireModule("pdfjs-dist/package.json").version);
export const PDFJS_BASE = `/vendor/pdfjs-${PDFJS_VERSION}`;
// Besides the two modules, PDF.js loads data on demand: character maps (CJK text),
// standard font data, image decoders (wasm) and colour profiles. Without them some
// PDFs render with missing text or not at all. Only files PDF.js ships are served:
// the allowlist is built from its own directories at startup.
const pdfjsRoot = dirname(requireModule.resolve("pdfjs-dist/package.json"));
const PDFJS_TYPES: Record<string, string> = { ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };
const pdfjsFiles = new Map<string, { body: Buffer; type: string }>();
pdfjsFiles.set("pdf.min.mjs", { body: readFileSync(join(pdfjsRoot, "legacy/build/pdf.min.mjs")), type: PDFJS_TYPES[".mjs"]! });
pdfjsFiles.set("pdf.worker.min.mjs", { body: readFileSync(join(pdfjsRoot, "legacy/build/pdf.worker.min.mjs")), type: PDFJS_TYPES[".mjs"]! });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  for (const file of readdirSync(join(pdfjsRoot, dir))) {
    if (file.startsWith("LICENSE")) continue;
    pdfjsFiles.set(`${dir}/${file}`, { body: readFileSync(join(pdfjsRoot, dir, file)), type: PDFJS_TYPES[extname(file)] ?? "application/octet-stream" });
  }
}
// Only the installed version answers, so a versioned URL stays a valid immutable
// cache key across upgrades: an old page's URLs 404 instead of getting mixed files.
route("GET", new RegExp(`^${PDFJS_BASE.replace(/[.]/g, "\\.")}/(.+)$`), async (_req, res, [path]) => {
  const file = pdfjsFiles.get(path!);
  if (!file) throw new HttpError(404, "not found");
  res.writeHead(200, { "Content-Type": file.type, "Content-Length": String(file.body.length), "Cache-Control": "public, max-age=31536000, immutable" });
  res.end(file.body);
});
route("GET", /^\/brand\/mark\.png$/, async (_req, res) => {
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" });
  res.end(brandMark);
});

// ---- JSON API ----------------------------------------------------------------------
// For sending and checking contracts from a Claude Code session (the send-contract skill
// in skill-shelf). Bearer-key only, off unless CONTRACTS_API_TOKEN is set. It creates
// requests through the same path as the admin form, so every audit rule still applies.

function requireApi(req: IncomingMessage): void {
  if (!apiEnabled) throw new HttpError(404, "the API is not enabled");
  if (!bearerTokenMatches(req, config.apiToken)) throw new HttpError(401, "missing or wrong API key");
}

const VIEWS: readonly RequestView[] = ["all", "waiting_client", "waiting_me", "completed", "voided"];

/** The list view, or a 400. The store falls back to "all" for an unknown view, which an
 * API client would mistake for a filtered result. */
function viewParam(url: URL): RequestView {
  const raw = url.searchParams.get("view") || "all";
  if (!(VIEWS as readonly string[]).includes(raw)) throw new HttpError(400, `view must be one of ${VIEWS.join(", ")}`);
  return raw as RequestView;
}

/** A whole number within bounds, or a 400. Postgres rejects fractional or huge LIMIT/OFFSET. */
function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  }
  return Number(raw);
}

const adminUrl = (id: string) => `${config.baseUrl}/requests/${id}`;

function signerJson(s: { name: string; email: string; order: number; status: string; signedAt?: string }) {
  return { name: s.name, email: s.email, order: s.order, status: s.status, signedAt: s.signedAt ?? null };
}

// Create and send. With dryRun=1 the upload is validated and described, and nothing is
// stored or sent, so the caller can show exactly what will go out before confirming.
route("POST", /^\/api\/requests$/, async (req, res) => {
  requireApi(req);
  const body = await readBody(req, config.maxUploadBytes);
  const parts = parseMultipart(body, String(req.headers["content-type"] ?? ""));
  const intake = await validateContractUpload(parts);
  if (!intake.ok) throw new HttpError(400, intake.error);
  const u = intake.upload;
  const client = { name: u.clientName, email: u.clientEmail };
  const firstSigner = u.order === "me_first" ? config.adminSigner : client;
  const summary = {
    title: u.title, filename: u.filename, pdfSha256: u.pdfSha256, pageCount: u.pageCount, order: u.order,
    client, countersigner: config.adminSigner, firstSigner,
  };
  // A retry of a send that already went through (same key, still pending) returns that
  // contract instead of creating and emailing a second one. Every contract-defining field
  // must match, and the response describes what is stored, not what this call asked for.
  const existingResponse = async (id: string) => {
    const [existing, doc] = await Promise.all([store.getRequest(id), store.getDocumentMeta(id)]);
    if (!existing || !doc) throw new HttpError(500, "idempotency key points at a missing request");
    const order = existing.metadata?.order;
    const mismatched = idempotencyMismatches(u, config.adminSigner, {
      title: existing.title, filename: doc.filename, pdfSha256: doc.pdfSha256, order, signers: existing.signers,
    });
    if (mismatched.length) {
      throw new HttpError(409, `this idempotencyKey was already used for a different contract (differs in: ${mismatched.join(", ")})`);
    }
    const signers = [...existing.signers].sort((a, b) => a.order - b.order).map((s) => ({ name: s.name, email: s.email }));
    const storedCountersigner = order === "me_first" ? signers[0]! : signers[1]!;
    const storedClient = order === "me_first" ? signers[1]! : signers[0]!;
    // The original call's response may have been lost, so report the invite outcome from
    // what was persisted: sendInvite records a "sent" event only after the email went out.
    const first = [...existing.signers].sort((a, b) => a.order - b.order)[0]!;
    const inviteSent = (await store.listAuditEvents(id)).some((e) => e.type === "sent" && e.signerId === first.id);
    return {
      id, status: existing.status, adminUrl: adminUrl(id),
      title: existing.title, filename: doc.filename, pdfSha256: doc.pdfSha256, pageCount: u.pageCount, order,
      client: storedClient, countersigner: storedCountersigner, firstSigner: signers[0]!,
      duplicate: true, inviteSent,
      inviteError: inviteSent ? null : `no invite is recorded as sent to ${first.email}; use "Resend link" on the contract page`,
      warning: null,
    };
  };
  const existingId = u.idempotencyKey ? await store.findPendingByIdempotencyKey(u.idempotencyKey) : null;
  if (formField(parts, "dryRun") === "1") {
    // Same check as the real send, so a preview never promises a duplicate the send would refuse.
    if (existingId) await existingResponse(existingId);
    json(res, 200, { dryRun: true, ...summary, alreadySent: existingId ? { id: existingId, adminUrl: adminUrl(existingId) } : null });
    return;
  }
  if (existingId) {
    json(res, 200, await existingResponse(existingId));
    return;
  }
  let created: Awaited<ReturnType<typeof createAndSend>>;
  try {
    created = await createAndSend(u, "api", req);
  } catch (error) {
    // Two identical sends racing: the unique index lets one in; the other returns it.
    const raced = u.idempotencyKey && (error as { code?: string }).code === "23505"
      ? await store.findPendingByIdempotencyKey(u.idempotencyKey) : null;
    if (!raced) throw error;
    json(res, 200, await existingResponse(raced));
    return;
  }
  const { request, first, inviteError, auditWarning } = created;
  console.log(`[api] created request ${request.id} "${u.title}", invite to ${first.email}${inviteError ? " FAILED" : ""}`);
  json(res, 201, {
    id: request.id, status: request.status, adminUrl: adminUrl(request.id), ...summary,
    duplicate: false, inviteSent: !inviteError, inviteError: inviteError ?? null, warning: auditWarning ?? null,
  });
});

route("GET", /^\/api\/requests$/, async (req, res, _p, url) => {
  requireApi(req);
  const limit = intParam(url, "limit", 25, 1, 100);
  const offset = intParam(url, "offset", 0, 0, 1_000_000);
  const list = await store.listRequests({
    q: (url.searchParams.get("q") ?? "").slice(0, 200), view: viewParam(url),
    adminEmail: config.adminSigner.email, limit, offset,
  });
  json(res, 200, {
    view: list.view, total: list.total, counts: list.counts,
    requests: list.rows.map((r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.createdAt, adminUrl: adminUrl(r.id), signers: r.signers.map(signerJson) })),
  });
});

route("GET", new RegExp(`^/api/requests/${UUID}$`), async (req, res, [id]) => {
  requireApi(req);
  const request = await store.getRequest(id!);
  const doc = await store.getDocumentMeta(id!);
  if (!request || !doc) throw new HttpError(404, "no such request");
  const [events, deliveries] = await Promise.all([store.listAuditEvents(id!), store.listDeliveries(id!)]);
  const emailOf = new Map(request.signers.map((s) => [s.id, s.email]));
  json(res, 200, {
    id: request.id, title: request.title, status: request.status, createdAt: request.createdAt, adminUrl: adminUrl(request.id),
    filename: doc.filename, pdfSha256: doc.pdfSha256, signedSha256: doc.signedSha256 ?? null, completedAt: doc.completedAt ?? null,
    // A voided request still has pending signers, but nobody can sign it any more.
    nextSigner: (() => { const n = request.status === "pending" ? nextSignerToInvite(request) : undefined; return n ? { name: n.name, email: n.email } : null; })(),
    signers: request.signers.map(signerJson),
    events: events.map((e) => ({ type: e.type, signer: emailOf.get(e.signerId) ?? null, occurredAt: e.occurredAt })),
    deliveries: deliveries.map((d) => ({
      signer: emailOf.get(d.signerId) ?? null, deliveredAt: d.deliveredAt ?? null,
      attempts: d.attempts, lastAttemptAt: d.lastAttemptAt ?? null, lastError: d.lastError ?? null,
      // Same rule as the contract page: past the retry limit only "Resend executed PDF" helps.
      state: d.deliveredAt ? "delivered" : d.attempts === 0 ? "pending" : d.attempts < MAX_DELIVERY_ATTEMPTS ? "retrying" : "failed",
    })),
  });
});

route("GET", /^\/healthz$/, async (_req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", config.baseUrl);
  const host = String(req.headers.host ?? "").toLowerCase().split(":")[0];
  if (config.redirectHosts.includes(host) && url.pathname !== "/healthz") {
    // 308 keeps the method and body, so a form posted to the old address still lands.
    res.writeHead(308, { Location: `${config.baseUrl}${req.url ?? "/"}`, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;
      await r.handler(req, res, match.slice(1), url);
      return;
    }
    if (url.pathname.startsWith("/api/")) { json(res, 404, { error: "not found" }); return; }
    html(res, 404, pages.messagePage("Not found", "There is nothing at this address."));
  } catch (error) {
    const isApi = url.pathname.startsWith("/api/");
    if (error instanceof HttpError) {
      if (isApi) json(res, error.status, { error: error.message });
      else html(res, error.status, pages.messagePage("Error", error.message));
      return;
    }
    console.error(`[${req.method} ${url.pathname}]`, error);
    if (isApi) { json(res, 500, { error: "server error" }); return; }
    html(res, 500, pages.messagePage("Something went wrong", "The server hit an error. Please try again, or contact Automation Architecture AI."));
  }
});

if (!transport && !config.emailDevLog) console.error("[email] SMTP_USER/SMTP_PASSWORD not set: every send will fail until they are");

store.migrate().then(() => {
  setInterval(retryDueDeliveries, Number(process.env.DELIVERY_RETRY_INTERVAL_MS ?? 60_000)).unref();
  server.listen(config.port, () => console.log(`contract app listening on :${config.port} (${config.baseUrl})`));
}).catch((error) => { console.error("failed to start", error); process.exit(1); });
