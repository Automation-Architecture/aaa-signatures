// contract.automationarchitecture.ai: upload a PDF, send it to a client and the operator
// for sequential signature, then deliver the executed PDF with a signature certificate.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { config } from "./config.ts";
import { PgStore } from "./store.ts";
import { buildSignedPdf } from "./pdf.ts";
import * as pages from "./pages.ts";
import {
  HttpError, clientIp, userAgent, readBody, parseMultipart, parseForm, isAdmin, setSessionCookie,
  clearSessionCookie, constantTimeEqual, html, redirect,
} from "./http.ts";
import { createSignatureRequest, issueSignerToken, nextSignerToInvite } from "../request.ts";
import { getSigningView, captureSignature, SigningError } from "../sign.ts";
import { verifyToken, newId } from "../token.ts";
import { inviteEmail } from "../email.ts";
import type { SignatureRequest, Signer } from "../types.ts";

const store = new PgStore(config.databaseUrl);
const secure = config.baseUrl.startsWith("https://");

// ---- email -------------------------------------------------------------------------

interface Attachment { name: string; content: Buffer }

async function sendEmail(input: { to: { email: string; name: string }; subject: string; html: string; text: string; attachments?: Attachment[] }) {
  if (!config.brevoApiKey) {
    console.warn(`[email] BREVO_API_KEY not set; would have sent "${input.subject}" to ${input.to.email}\n${input.text}`);
    return;
  }
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": config.brevoApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: config.emailFrom,
      to: [input.to],
      subject: input.subject,
      htmlContent: input.html,
      textContent: input.text,
      tags: ["aaa-contract"],
      attachment: input.attachments?.map((a) => ({ name: a.name, content: a.content.toString("base64") })),
    }),
  });
  if (!response.ok) throw new Error(`Brevo send failed: ${response.status} ${await response.text()}`);
}

function signingUrl(request: SignatureRequest, signer: Signer, token: string) {
  return `${config.baseUrl}/sign/${request.id}/${signer.id}?token=${encodeURIComponent(token)}`;
}

async function sendInvite(request: SignatureRequest, signer: Signer, token: string, isCountersigner: boolean, req?: IncomingMessage) {
  const message = inviteEmail({ signerName: signer.name, requestTitle: request.title, signingUrl: signingUrl(request, signer, token), isCountersigner });
  await sendEmail({ to: { email: signer.email, name: signer.name }, ...message });
  await store.appendAuditEvent({
    id: newId(), requestId: request.id, signerId: signer.id, type: "sent", occurredAt: new Date().toISOString(),
    ip: req ? clientIp(req) : undefined, userAgent: req ? userAgent(req) : undefined, detail: { to: signer.email, isCountersigner },
  });
}

async function completeRequest(requestId: string) {
  const request = await store.getRequest(requestId);
  const doc = await store.getDocument(requestId);
  if (!request || !doc) throw new Error("request or document missing at completion");
  const completedAt = new Date().toISOString();
  const events = await store.listAuditEvents(requestId);
  const signedPdf = await buildSignedPdf({ originalPdf: doc.pdf, request, auditEvents: events, pdfSha256: doc.pdfSha256, completedAt });
  const signedSha256 = createHash("sha256").update(signedPdf).digest("hex");
  await store.saveSignedPdf(requestId, signedPdf, signedSha256, completedAt);

  const filename = doc.filename.replace(/\.pdf$/i, "") + " (signed).pdf";
  for (const signer of request.signers) {
    const subject = `Signed and complete: ${request.title}`;
    const text = `Hi ${signer.name},\n\nEveryone has signed "${request.title}". The fully executed PDF, including the signature certificate, is attached for your records.\n\nExecuted PDF SHA-256: ${signedSha256}\n\nAutomation Architecture AI`;
    const body = `<p>Hi ${pages.esc(signer.name)},</p><p>Everyone has signed <strong>${pages.esc(request.title)}</strong>. The fully executed PDF, including the signature certificate, is attached for your records.</p><p style="font-size:.85em;color:#636363">Executed PDF SHA-256: ${signedSha256}</p><p>Automation Architecture AI</p>`;
    try {
      await sendEmail({ to: { email: signer.email, name: signer.name }, subject, html: body, text, attachments: [{ name: filename, content: signedPdf }] });
    } catch (error) {
      console.error(`[email] completion email to ${signer.email} failed`, error);
    }
  }
}

// ---- routing -----------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void>;
const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

const UUID = "([0-9a-f-]{36})";

function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAdmin(req, config.sessionSecret)) return true;
  html(res, 200, pages.loginPage());
  return false;
}

// Admin: dashboard + upload
route("GET", /^\/$/, async (req, res, _p, url) => {
  if (!requireAdmin(req, res)) return;
  const requests = await store.listRequests();
  html(res, 200, pages.adminPage({ requests, adminSigner: config.adminSigner, notice: url.searchParams.get("notice") ?? undefined, error: url.searchParams.get("error") ?? undefined }));
});

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
route("POST", /^\/login$/, async (req, res) => {
  const ip = clientIp(req) ?? "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.resetAt > now && attempt.count >= 10) {
    html(res, 429, pages.loginPage("Too many attempts. Try again in 15 minutes."));
    return;
  }
  const form = parseForm(await readBody(req, 4096));
  if (constantTimeEqual(form.password ?? "", config.adminPassword)) {
    loginAttempts.delete(ip);
    setSessionCookie(res, config.sessionSecret, secure);
    redirect(res, "/");
    return;
  }
  loginAttempts.set(ip, { count: (attempt && attempt.resetAt > now ? attempt.count : 0) + 1, resetAt: now + 15 * 60 * 1000 });
  html(res, 401, pages.loginPage("Wrong password."));
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
  html(res, 200, pages.requestDetailPage({
    request, events, filename: doc.filename, pdfSha256: doc.pdfSha256, hasSigned: Boolean(doc.signedPdf),
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
    if (result.completed) {
      await completeRequest(request.id);
    } else if (result.nextSigner) {
      const token = await issueSignerToken(store, request.id, result.nextSigner.id, config.linkExpiresInDays);
      try { await sendInvite(request, result.nextSigner, token, true); } catch (error) { console.error("[email] countersign invite failed", error); }
    }
    html(res, 200, pages.signedThanksPage({ request, completed: result.completed, nextSigner: result.nextSigner }));
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

store.migrate().then(() => {
  server.listen(config.port, () => console.log(`contract app listening on :${config.port} (${config.baseUrl})`));
}).catch((error) => { console.error("failed to start", error); process.exit(1); });
