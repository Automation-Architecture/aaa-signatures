// Server-rendered pages. Brand: Automation-Architecture/aaa-brand DESIGN.md (Jura, teal, lime accent).
import type { AuditEvent, SignatureRequest, Signer } from "../types.ts";
import { MAX_DELIVERY_ATTEMPTS, type Delivery, type RequestSummary } from "./store.ts";

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
:root{--lime:#e6ff2b;--teal:#004d43;--cream:#f9f7f2;--surface:#f7f7f7;--muted:#f1f0ec;--white:#fff;--black:#010101;--heading:#1b1b1b;--body:#636363;--divider:#d8d8d8;--success:#0f766e;--destructive:#d93025}
*{box-sizing:border-box}
html{font-family:"Jura",ui-sans-serif,system-ui,sans-serif;background:var(--cream);color:var(--heading);line-height:1.6}
body{margin:0;min-height:100vh}
header{background:var(--teal);color:var(--cream);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}
header .brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--cream)}
header .mark{width:28px;height:28px;border-radius:6px;background:var(--lime)}
header .label{font-weight:700;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--lime)}
header .title{font-weight:600;text-transform:uppercase;line-height:1.1;font-size:1rem}
header a.nav{color:var(--cream);font-size:.85rem}
main{max-width:920px;margin:0 auto;padding:32px 16px 64px}
h1,h2,h3{text-transform:uppercase;line-height:1.1;font-weight:600;color:var(--teal);margin:0 0 16px}
h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:32px}
.card{background:var(--white);border:1px solid var(--divider);border-radius:10px;padding:24px;margin-bottom:24px}
label{display:block;font-weight:700;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;margin:14px 0 6px}
input[type=text],input[type=email],input[type=password],input[type=file],select{width:100%;padding:11px 12px;border:1px solid var(--divider);border-radius:6px;font:inherit;background:var(--white);color:var(--heading)}
input:focus,select:focus{outline:2px solid var(--teal);outline-offset:1px}
.btn{display:inline-block;padding:12px 22px;border:0;border-radius:3px 3px 10px 3px;font:inherit;font-weight:700;font-size:.85rem;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;text-decoration:none}
.btn-primary{background:var(--lime);color:var(--black)}.btn-primary:hover{opacity:.9}
.btn-secondary{background:var(--teal);color:var(--white)}
.btn-ghost{background:transparent;color:var(--teal);border:1px solid var(--divider)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.muted{color:var(--body);font-size:.9rem}
.error{background:#fdecea;border:1px solid var(--destructive);color:var(--destructive);padding:12px 14px;border-radius:6px;margin-bottom:16px}
.ok{background:#e6f4f2;border:1px solid var(--success);color:var(--success);padding:12px 14px;border-radius:6px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{background:var(--teal);color:var(--white);text-align:left;padding:10px;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase}
td{padding:10px;border-bottom:1px solid var(--divider);vertical-align:top}
.pill{display:inline-block;padding:2px 8px;border-radius:6px;font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:var(--muted);color:var(--heading)}
.pill.completed,.pill.signed{background:#e6f4f2;color:var(--success)}
.pill.voided{background:#fdecea;color:var(--destructive)}
.doc{width:100%;height:78vh;border:1px solid var(--divider);border-radius:6px;background:var(--surface)}
.check{display:flex;gap:12px;align-items:flex-start;margin:16px 0;font-size:.95rem}
.check input{margin-top:5px;width:18px;height:18px;accent-color:var(--teal)}
.disclosure{background:var(--muted);border-left:4px solid var(--teal);padding:14px 16px;font-size:.9rem;margin:16px 0}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:640px){.row{grid-template-columns:1fr}.doc{height:60vh}}
code{font-size:.8em;word-break:break-all}
footer{text-align:center;color:var(--body);font-size:.8rem;padding:24px}
`;

export function layout(title: string, body: string, opts: { admin?: boolean } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Jura:wght@400;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header><a class="brand" href="/"><span class="mark"></span><span><span class="label">Automation Architecture AI</span><br><span class="title">Contracts</span></span></a>
${opts.admin ? `<form method="post" action="/logout" style="margin:0"><button class="btn btn-ghost" style="color:var(--cream)">Log out</button></form>` : ""}</header>
<main>${body}</main>
<footer>Automation Architecture AI | automationarchitecture.ai</footer>
</body></html>`;
}

export function loginPage(error?: string): string {
  return layout("Sign in", `<h1>Sign in</h1><div class="card" style="max-width:420px">
${error ? `<div class="error">${esc(error)}</div>` : ""}
<form method="post" action="/login"><label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required autofocus>
<div style="margin-top:20px"><button class="btn btn-primary">Sign in</button></div></form></div>`);
}

export function adminPage(input: { requests: RequestSummary[]; adminSigner: { name: string; email: string }; notice?: string; error?: string }): string {
  const rows = input.requests
    .map((r) => {
      const client = r.signers.find((s) => s.email !== input.adminSigner.email) ?? r.signers[0];
      const progress = r.signers.map((s) => `<span class="pill ${esc(s.status)}">${esc(s.name.split(" ")[0])}: ${esc(s.status)}</span>`).join(" ");
      return `<tr><td><a href="/requests/${esc(r.id)}">${esc(r.title)}</a><br><span class="muted">${esc(client?.name ?? "")} · ${esc(client?.email ?? "")}</span></td>
<td>${esc(r.createdAt.slice(0, 10))}</td><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td><td>${progress}</td></tr>`;
    })
    .join("");

  return layout(
    "Send a contract",
    `${input.notice ? `<div class="ok">${esc(input.notice)}</div>` : ""}${input.error ? `<div class="error">${esc(input.error)}</div>` : ""}
<h1>Send a contract for signature</h1>
<div class="card"><form method="post" action="/requests" enctype="multipart/form-data">
<label for="title">Contract title</label><input id="title" type="text" name="title" placeholder="e.g. Master Services Agreement, Acme Co" required maxlength="200">
<label for="pdf">Contract PDF</label><input id="pdf" type="file" name="pdf" accept="application/pdf,.pdf" required>
<div class="row"><div><label for="cn">Client signer name</label><input id="cn" type="text" name="clientName" required maxlength="120" autocomplete="off"></div>
<div><label for="ce">Client signer email</label><input id="ce" type="email" name="clientEmail" required maxlength="200" autocomplete="off"></div></div>
<label for="order">Signing order</label><select id="order" name="order">
<option value="client_first">Client signs first, then ${esc(input.adminSigner.name)} countersigns</option>
<option value="me_first">${esc(input.adminSigner.name)} signs first, then the client</option></select>
<p class="muted">You countersign as ${esc(input.adminSigner.name)} (${esc(input.adminSigner.email)}). Each signer gets a single-use link by email that expires in 14 days. Once both have signed, both receive the executed PDF with a signature certificate.</p>
<button class="btn btn-primary">Send for signature</button></form></div>
<h2>Contracts</h2>
<div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>Contract</th><th>Sent</th><th>Status</th><th>Signers</th></tr></thead>
<tbody>${rows || `<tr><td colspan="4" class="muted">Nothing sent yet.</td></tr>`}</tbody></table></div>`,
    { admin: true },
  );
}

export function requestDetailPage(input: {
  request: SignatureRequest;
  events: AuditEvent[];
  deliveries: Delivery[];
  filename: string;
  pdfSha256: string;
  hasSigned: boolean;
  notice?: string;
  error?: string;
}): string {
  const { request } = input;
  const byId = new Map(request.signers.map((s) => [s.id, s]));
  const deliveryBySigner = new Map(input.deliveries.map((d) => [d.signerId, d]));
  const deliveryCell = (signerId: string) => {
    const d = deliveryBySigner.get(signerId);
    if (!d) return request.status === "completed" ? `<span class="muted">not recorded</span>` : "";
    if (d.deliveredAt) return `<span class="pill signed">sent</span><br><span class="muted">${esc(d.deliveredAt)}</span>`;
    const retrying = d.attempts < MAX_DELIVERY_ATTEMPTS;
    return `<span class="pill voided">${retrying ? "retrying" : "failed"}</span><br><span class="muted">${d.attempts} attempt${d.attempts === 1 ? "" : "s"}${d.lastError ? `: ${esc(d.lastError.slice(0, 160))}` : ""}</span>`;
  };
  const signerRows = [...request.signers]
    .sort((a, b) => a.order - b.order)
    .map(
      (s) => `<tr><td>${s.order + 1}</td><td>${esc(s.name)}<br><span class="muted">${esc(s.email)}</span></td>
<td><span class="pill ${esc(s.status)}">${esc(s.status)}</span></td><td>${esc(s.signedAt ?? "")}</td><td>${deliveryCell(s.id)}</td>
<td>${s.status === "pending" && request.status === "pending" ? `<form method="post" action="/requests/${esc(request.id)}/resend" style="margin:0"><input type="hidden" name="signerId" value="${esc(s.id)}"><button class="btn btn-ghost">Resend link</button></form>` : ""}</td></tr>`,
    )
    .join("");
  const eventRows = input.events
    .map(
      (e) => `<tr><td>${esc(e.occurredAt)}</td><td>${esc(byId.get(e.signerId)?.name ?? e.signerId)}</td><td><span class="pill">${esc(e.type)}</span></td>
<td class="muted">${esc(e.ip ?? "")}${e.detail?.typedLegalName ? `<br>signed as "${esc(e.detail.typedLegalName)}"` : ""}</td></tr>`,
    )
    .join("");

  return layout(
    request.title,
    `<p><a href="/">&larr; All contracts</a></p>
${input.notice ? `<div class="ok">${esc(input.notice)}</div>` : ""}${input.error ? `<div class="error">${esc(input.error)}</div>` : ""}
<h1>${esc(request.title)}</h1>
<p><span class="pill ${esc(request.status)}">${esc(request.status)}</span> &nbsp; <span class="muted">Created ${esc(request.createdAt)} · ${esc(input.filename)}</span></p>
<div class="card">
<a class="btn btn-secondary" href="/requests/${esc(request.id)}/original.pdf">Original PDF</a>
${input.hasSigned ? ` <a class="btn btn-primary" href="/requests/${esc(request.id)}/signed.pdf">Executed PDF</a>` : ""}
${request.status === "completed" ? ` <form method="post" action="/requests/${esc(request.id)}/finalize" style="display:inline"><button class="btn btn-ghost">${input.hasSigned ? "Resend executed PDF" : "Finalize and send"}</button></form>` : ""}
${request.status === "completed" && !input.hasSigned ? `<p class="error" style="margin-top:16px">Both parties signed, but the executed PDF hasn't been generated or sent yet. Use Finalize and send.</p>` : ""}
${request.status === "pending" ? ` <form method="post" action="/requests/${esc(request.id)}/void" style="display:inline" onsubmit="return confirm('Void this request? Links stop working immediately.')"><button class="btn btn-ghost">Void request</button></form>` : ""}
<p class="muted" style="margin-top:16px">Original SHA-256: <code>${esc(input.pdfSha256)}</code><br>Record fingerprint: <code>${esc(request.documentSha256)}</code></p></div>
<h2>Signers</h2><div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>#</th><th>Signer</th><th>Status</th><th>Signed at (UTC)</th><th>Executed copy</th><th></th></tr></thead><tbody>${signerRows}</tbody></table></div>
<h2>Audit trail</h2><div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>When (UTC)</th><th>Who</th><th>Event</th><th>Detail</th></tr></thead><tbody>${eventRows || `<tr><td colspan="4" class="muted">No events yet.</td></tr>`}</tbody></table></div>`,
    { admin: true },
  );
}

export function signingPage(input: { request: SignatureRequest; signer: Signer; token: string; docUrl: string; otherParty?: Signer; error?: string }): string {
  const { request, signer } = input;
  return layout(
    `Sign: ${request.title}`,
    `<h1>${esc(request.title)}</h1>
<p class="muted">Prepared for <strong>${esc(signer.name)}</strong> (${esc(signer.email)})${input.otherParty ? ` · other party: ${esc(input.otherParty.name)}` : ""}. Please read the full document below, then sign at the bottom.</p>
${input.error ? `<div class="error">${esc(input.error)}</div>` : ""}
<iframe class="doc" src="${esc(input.docUrl)}" title="Contract document"></iframe>
<p class="muted">Trouble viewing? <a href="${esc(input.docUrl)}" target="_blank" rel="noopener">Open the PDF in a new tab</a>.</p>
<div class="card"><h2 style="margin-top:0">Sign this document</h2>
<div class="disclosure"><strong>Consent to electronic records and signatures.</strong> By checking the box and typing your name below, you agree that you have read this document, that you intend to sign it electronically, and that your electronic signature is the legal equivalent of your handwritten signature. You agree to receive this document and the signed copy electronically at the email address above. You may request a paper copy from Automation Architecture AI at any time.</div>
<form method="post" action="/sign/${esc(request.id)}/${esc(signer.id)}">
<input type="hidden" name="token" value="${esc(input.token)}"><input type="hidden" name="documentSha256Seen" value="${esc(request.documentSha256)}">
<label class="check" style="text-transform:none;letter-spacing:0;font-weight:400"><input type="checkbox" name="agree" value="yes" required><span>I agree to sign electronically and have read the document above.</span></label>
<label for="name">Type your full legal name to sign</label><input id="name" type="text" name="typedLegalName" placeholder="${esc(signer.name)}" required maxlength="200" autocomplete="name">
<p class="muted">Document fingerprint: <code>${esc(request.documentSha256)}</code></p>
<button class="btn btn-primary">Sign document</button></form></div>`,
  );
}

export function signedThanksPage(input: { request: SignatureRequest; completed: boolean; nextSigner?: Signer; finalized?: boolean }): string {
  return layout(
    "Signed",
    `<h1>Thank you. Your signature is recorded.</h1><div class="card">
<p><strong>${esc(input.request.title)}</strong></p>
${input.completed ? (input.finalized === false ? `<p>All parties have now signed. Your signature is safely recorded. The executed PDF will be emailed to you shortly.</p>` : `<p>All parties have now signed. The executed PDF, with a signature certificate, is on its way to your email.</p>`) : `<p>The document is now waiting on ${esc(input.nextSigner?.name ?? "the other party")} to countersign. You will receive the fully executed copy by email once they have.</p>`}
<p class="muted">You can close this page.</p></div>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><div class="card"><p>${esc(message)}</p></div>`);
}
