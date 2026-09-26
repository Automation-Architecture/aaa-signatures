// contract.automationarchitecture.ai: upload a PDF, send it to a client and the operator
// for sequential signature, then deliver the executed PDF with a signature certificate.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import { config, googleEnabled } from "./config.ts";
import { beginGoogleLogin, completeGoogleLogin } from "./google.ts";
import { PgStore } from "./store.ts";
import { buildSignedPdf } from "./pdf.ts";
import * as pages from "./pages.ts";
import {
  HttpError, clientIp, userAgent, readBody, parseMultipart, parseForm, readSession, setSessionCookie,
  clearSessionCookie, constantTimeEqual, html, redirect,
} from "./http.ts";
import { createSignatureRequest, issueSignerToken, nextSignerToInvite } from "../request.ts";
import { getSigningView, captureSignature, SigningError } from "../sign.ts";
import { verifyToken, newId } from "../token.ts";
import { inviteEmail, completedEmail } from "./emails.ts";
import { readFileSync } from "node:fs";
import type { SignatureRequest, Signer } from "../types.ts";

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
  if (!transport) {
    if (!config.emailDevLog) {
      throw new Error("email is not configured: set SMTP_USER and SMTP_PASSWORD (or EMAIL_DEV_LOG=1 for local development)");
    }
    console.warn(`[email] EMAIL_DEV_LOG: would have sent "${input.subject}" to ${input.to.email}\n${input.text}`);
    return;
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

async function sendInvite(request: SignatureRequest, signer: Signer, token: string, isCountersigner: boolean, req?: IncomingMessage) {
  const message = inviteEmail({ baseUrl: config.baseUrl, signerName: signer.name, requestTitle: request.title, signingUrl: signingUrl(request, signer, token), isCountersigner, expiresInDays: config.linkExpiresInDays });
  await sendEmail({ to: { email: signer.email, name: signer.name }, ...message });
  await store.appendAuditEvent({
    id: newId(), requestId: request.id, signerId: signer.id, type: "sent", occurredAt: new Date().toISOString(),
    ip: req ? clientIp(req) : undefined, userAgent: req ? userAgent(req) : undefined, detail: { to: signer.email, isCountersigner },
  });
}

/** Build and store the executed PDF if it doesn't exist yet. Safe to call again: an
 * existing executed PDF is reused, so its bytes and fingerprint never change. */
async function ensureSignedPdf(requestId: string) {
  const request = await store.getRequest(requestId);
  const doc = await store.getDocument(requestId);
  if (!request || !doc) throw new Error("request or document missing at completion");
  if (request.status !== "completed") throw new Error("request is not completed");
  if (doc.signedPdf && doc.signedSha256) return { request, doc, signedPdf: doc.signedPdf, signedSha256: doc.signedSha256 };

  const completedAt = new Date().toISOString();
  const events = await store.listAuditEvents(requestId);
  const signedPdf = await buildSignedPdf({ originalPdf: doc.pdf, request, auditEvents: events, pdfSha256: doc.pdfSha256, completedAt });
  const signedSha256 = createHash("sha256").update(signedPdf).digest("hex");
  await store.saveSignedPdf(requestId, signedPdf, signedSha256, completedAt);
  return { request, doc, signedPdf, signedSha256 };
}

const finalizing = new Set<string>();

/**
 * Deliver the executed PDF to every signer who hasn't received it yet (or to every
 * signer when `force` is set, for the admin's "Resend" button). Delivery state is
 * persisted per signer, so a failure is retried by the background worker instead of
 * being lost in a log line. Returns the addresses that failed this time.
 */
async function sendCompletionEmails(requestId: string, opts: { force?: boolean } = {}): Promise<string[]> {
  if (finalizing.has(requestId)) return [];
  finalizing.add(requestId);
  try {
    const request = await store.getRequest(requestId);
    if (!request) throw new Error("no such request");
    await store.ensureDeliveries(requestId, request.signers.map((s) => s.id));
    const pending = new Set(
      (await store.listDeliveries(requestId)).filter((d) => opts.force || !d.deliveredAt).map((d) => d.signerId),
    );
    if (pending.size === 0) return [];

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
    return failed;
  } finally {
    finalizing.delete(requestId);
  }
}

/** Background retry for completion deliveries that failed. */
async function retryDueDeliveries() {
  try {
    for (const requestId of await store.listDueDeliveries()) {
      try {
        const failed = await sendCompletionEmails(requestId);
        console.log(`[retry] request ${requestId}: ${failed.length ? `still failing for ${failed.join(", ")}` : "delivered"}`);
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

const UUID = "([0-9a-f-]{36})";

function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  const session = readSession(req, config.sessionSecret);
  // Re-check the allowlist on every request, so removing an address from
  // ALLOWED_EMAILS ends that person's existing sessions too.
  if (session && (session.email === "password" ? !googleEnabled : config.allowedEmails.includes(session.email))) return true;
  html(res, 200, pages.loginPage({ google: googleEnabled }));
  return false;
}

// Admin: dashboard + upload
route("GET", /^\/$/, async (req, res, _p, url) => {
  if (!requireAdmin(req, res)) return;
  const requests = await store.listRequests();
  html(res, 200, pages.adminPage({ requests, adminSigner: config.adminSigner, notice: url.searchParams.get("notice") ?? undefined, error: url.searchParams.get("error") ?? undefined }));
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

route("POST", /^\/requests$/, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req, config.maxUploadBytes);
  const parts = parseMultipart(body, String(req.headers["content-type"] ?? ""));
  const field = (name: string) => parts.find((p) => p.name === name && !p.filename)?.data.toString("utf8").trim() ?? "";
  const file = parts.find((p) => p.name === "pdf" && p.filename);

  const title = field("title");
  const clientName = field("clientName");
  const clientEmail = field("clientEmail");
  const order = field("order");
  if (!title || !clientName || !clientEmail || !file || file.data.length === 0) {
    redirect(res, `/?error=${encodeURIComponent("Title, client name, client email and a PDF are all required.")}`);
    return;
  }
  if (!file.data.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    redirect(res, `/?error=${encodeURIComponent("That file is not a PDF.")}`);
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    redirect(res, `/?error=${encodeURIComponent("Client email does not look valid.")}`);
    return;
  }

  // Do the same work finalization will do (parse, add a page, save) so a PDF that
  // would break the executed record is refused now, not after both parties sign.
  try {
    const probe = await PDFDocument.load(file.data, { ignoreEncryption: true });
    if (probe.getPageCount() === 0) throw new Error("no pages");
    probe.addPage();
    await probe.save();
  } catch {
    redirect(res, `/?error=${encodeURIComponent("That PDF could not be read. Re-export it and try again.")}`);
    return;
  }

  const pdfSha256 = createHash("sha256").update(file.data).digest("hex");
  const client = { name: clientName, email: clientEmail };
  const me = config.adminSigner;
  const signers = order === "me_first" ? [me, client] : [client, me];
  const filename = (file.filename ?? "contract.pdf").replace(/[^\w .()-]+/g, "_");

  // documentHtml is what the library fingerprints; binding the PDF's own hash and the
  // parties into it means the record fingerprint changes if any of those change.
  const documentHtml = `<p>Contract: ${pages.esc(title)}</p><p>File: ${pages.esc(filename)}</p><p>PDF SHA-256: ${pdfSha256}</p>` +
    `<p>Parties: ${signers.map((s) => `${pages.esc(s.name)} &lt;${pages.esc(s.email)}&gt;`).join("; ")}</p>`;

  const { request, rawTokens } = await createSignatureRequest(store, {
    title, documentHtml, signers, expiresInDays: config.linkExpiresInDays,
    metadata: { filename, pdfSha256, order: order === "me_first" ? "me_first" : "client_first" },
  });
  await store.saveDocument({ requestId: request.id, filename, pdf: file.data, pdfSha256 });

  const first = request.signers.find((s) => s.order === 0)!;
  try {
    await sendInvite(request, first, rawTokens.get(first.id)!, false, req);
  } catch (error) {
    console.error("[email] invite failed", error);
    redirect(res, `/requests/${request.id}?error=${encodeURIComponent("Request created but the invite email failed to send. Use Resend link.")}`);
    return;
  }
  redirect(res, `/requests/${request.id}?notice=${encodeURIComponent(`Sent to ${first.name} (${first.email}).`)}`);
});

route("GET", new RegExp(`^/requests/${UUID}$`), async (req, res, [id], url) => {
  if (!requireAdmin(req, res)) return;
  const request = await store.getRequest(id!);
  const doc = await store.getDocument(id!);
  if (!request || !doc) throw new HttpError(404, "no such request");
  const events = await store.listAuditEvents(id!);
  const deliveries = await store.listDeliveries(id!);
  html(res, 200, pages.requestDetailPage({
    request, events, deliveries, filename: doc.filename, pdfSha256: doc.pdfSha256, hasSigned: Boolean(doc.signedPdf),
    notice: url.searchParams.get("notice") ?? undefined, error: url.searchParams.get("error") ?? undefined,
  }));
});

route("GET", new RegExp(`^/requests/${UUID}/(original|signed)\\.pdf$`), async (req, res, [id, which]) => {
  if (!requireAdmin(req, res)) return;
  const doc = await store.getDocument(id!);
  if (!doc) throw new HttpError(404, "no such request");
  const bytes = which === "signed" ? doc.signedPdf : doc.pdf;
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
    const failed = await sendCompletionEmails(id!, { force: true });
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
    html(res, 200, pages.signingPage({ request, signer, token, docUrl, otherParty, error: url.searchParams.get("error") ?? undefined }));
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
  const doc = await store.getDocument(request.id);
  if (!doc) throw new HttpError(404, "missing document");
  res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`, "Cache-Control": "no-store", "X-Frame-Options": "SAMEORIGIN" });
  res.end(doc.pdf);
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
        finalized = (await sendCompletionEmails(request.id)).length === 0;
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
route("GET", /^\/brand\/mark\.png$/, async (_req, res) => {
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" });
  res.end(brandMark);
});

route("GET", /^\/healthz$/, async (_req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", config.baseUrl);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;
      await r.handler(req, res, match.slice(1), url);
      return;
    }
    html(res, 404, pages.messagePage("Not found", "There is nothing at this address."));
  } catch (error) {
    if (error instanceof HttpError) { html(res, error.status, pages.messagePage("Error", error.message)); return; }
    console.error(`[${req.method} ${url.pathname}]`, error);
    html(res, 500, pages.messagePage("Something went wrong", "The server hit an error. Please try again, or contact Automation Architecture AI."));
  }
});

if (!transport && !config.emailDevLog) console.error("[email] SMTP_USER/SMTP_PASSWORD not set: every send will fail until they are");

store.migrate().then(() => {
  setInterval(retryDueDeliveries, Number(process.env.DELIVERY_RETRY_INTERVAL_MS ?? 60_000)).unref();
  server.listen(config.port, () => console.log(`contract app listening on :${config.port} (${config.baseUrl})`));
}).catch((error) => { console.error("failed to start", error); process.exit(1); });
