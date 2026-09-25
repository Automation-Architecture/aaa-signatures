// Branded transactional emails. Brand: Automation-Architecture/aaa-brand DESIGN.md.
// Email-client constraints: table layout, inline styles, PNG logo (Gmail blocks SVG),
// Jura with a system fallback since many clients ignore web fonts. Lime is only ever a
// fill carrying black text or an accent on teal, never text on white.
// Client-facing copy: no em or en dashes.
import { esc } from "./pages.ts";

const TEAL = "#004d43";
const LIME = "#e6ff2b";
const CREAM = "#f9f7f2";
const INK = "#1b1b1b";
const BODY = "#636363";
const DIVIDER = "#d8d8d8";
const FONT = `'Jura', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

export interface Email { subject: string; html: string; text: string }

function shell(input: { baseUrl: string; preheader: string; heading: string; body: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Jura:wght@400;600;700&display=swap" rel="stylesheet">
<title>${esc(input.heading)}</title></head>
<body style="margin:0;padding:0;background:${CREAM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${DIVIDER};border-radius:10px;overflow:hidden;">
<tr><td style="background:${TEAL};padding:24px 32px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="vertical-align:middle;padding-right:14px;"><img src="${input.baseUrl}/brand/mark.png" width="36" height="36" alt="" style="display:block;border:0;"></td>
    <td style="vertical-align:middle;font-family:${FONT};">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${LIME};">Automation Architecture AI</div>
      <div style="font-size:15px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${CREAM};margin-top:2px;">Contracts</div>
    </td></tr></table>
</td></tr>
<tr><td style="padding:32px 32px 8px;font-family:${FONT};">
  <h1 style="margin:0 0 20px;font-size:20px;line-height:1.2;font-weight:600;text-transform:uppercase;color:${TEAL};">${esc(input.heading)}</h1>
  ${input.body}
</td></tr>
<tr><td style="padding:24px 32px 28px;font-family:${FONT};border-top:1px solid ${DIVIDER};font-size:12px;line-height:1.6;color:${BODY};">
  Automation Architecture AI | <a href="https://automationarchitecture.ai" style="color:${TEAL};text-decoration:none;">automationarchitecture.ai</a><br>
  Questions? Reply to this email.
</td></tr>
</table></td></tr></table></body></html>`;
}

const p = (html: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${INK};">${html}</p>`;
const small = (html: string) => `<p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:${BODY};">${html}</p>`;
const docBox = (title: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 24px;"><tr>
<td style="width:4px;background:${TEAL};"></td>
<td style="background:#f1f0ec;padding:14px 16px;font-size:15px;font-weight:600;color:${INK};">${esc(title)}</td></tr></table>`;
const button = (href: string, label: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr>
<td style="background:${LIME};border-radius:3px 3px 10px 3px;">
<a href="${esc(href)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#010101;text-decoration:none;">${esc(label)}</a>
</td></tr></table>`;

export function inviteEmail(input: { baseUrl: string; signerName: string; requestTitle: string; signingUrl: string; isCountersigner: boolean; expiresInDays: number }): Email {
  const subject = input.isCountersigner ? `Please countersign: ${input.requestTitle}` : `Please sign: ${input.requestTitle}`;
  const intro = input.isCountersigner
    ? "The other party has signed. The document below is now waiting on your countersignature."
    : "Automation Architecture AI has sent you a document to review and sign electronically.";
  const html = shell({
    baseUrl: input.baseUrl,
    preheader: intro,
    heading: input.isCountersigner ? "Ready for your countersignature" : "Document ready for your signature",
    body:
      p(`Hi ${esc(input.signerName)},`) + p(esc(intro)) + docBox(input.requestTitle) +
      button(input.signingUrl, "Review and sign") +
      small(`This link is unique to you and expires in ${input.expiresInDays} days. Please don't forward it. If the button doesn't work, paste this address into your browser:<br><a href="${esc(input.signingUrl)}" style="color:${TEAL};word-break:break-all;">${esc(input.signingUrl)}</a>`),
  });
  const text = `Hi ${input.signerName},\n\n${intro}\n\n${input.requestTitle}\n\nReview and sign: ${input.signingUrl}\n\nThis link is unique to you and expires in ${input.expiresInDays} days. Please don't forward it.\n\nAutomation Architecture AI | automationarchitecture.ai`;
  return { subject, html, text };
}

export function completedEmail(input: { baseUrl: string; signerName: string; requestTitle: string; signedSha256: string }): Email {
  const subject = `Signed and complete: ${input.requestTitle}`;
  const html = shell({
    baseUrl: input.baseUrl,
    preheader: "Everyone has signed. Your executed copy is attached.",
    heading: "Signed and complete",
    body:
      p(`Hi ${esc(input.signerName)},`) +
      p("Everyone has signed. The fully executed PDF, including the signature certificate, is attached for your records.") +
      docBox(input.requestTitle) +
      small(`Executed PDF fingerprint (SHA-256):<br><span style="font-family:Menlo,Consolas,monospace;word-break:break-all;">${esc(input.signedSha256)}</span>`),
  });
  const text = `Hi ${input.signerName},\n\nEveryone has signed "${input.requestTitle}". The fully executed PDF, including the signature certificate, is attached for your records.\n\nExecuted PDF SHA-256: ${input.signedSha256}\n\nAutomation Architecture AI | automationarchitecture.ai`;
  return { subject, html, text };
}
