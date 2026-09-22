import type { EmailSender } from "./types.ts";

export interface InviteEmailInput {
  signerName: string;
  requestTitle: string;
  signingUrl: string;
  /** True for a countersigner going after another signer has already signed. */
  isCountersigner?: boolean;
}

export function inviteEmail(input: InviteEmailInput): { subject: string; html: string; text: string } {
  const subject = input.isCountersigner
    ? `Please countersign: ${input.requestTitle}`
    : `Please sign: ${input.requestTitle}`;
  const intro = input.isCountersigner
    ? "The other party has signed. This is now waiting on your countersignature."
    : "This is waiting on your signature.";
  const text = `Hi ${input.signerName},\n\n${intro}\n\nReview and sign here: ${input.signingUrl}\n\nThis link is unique to you and expires after 14 days.`;
  const html = `<p>Hi ${input.signerName},</p><p>${intro}</p><p><a href="${input.signingUrl}">Review and sign</a></p><p>This link is unique to you and expires after 14 days.</p>`;
  return { subject, html, text };
}

export function completedEmail(input: { signerName: string; requestTitle: string; recordUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Signed and complete: ${input.requestTitle}`;
  const text = `Hi ${input.signerName},\n\nEveryone has signed. Your copy of the fully executed record is here: ${input.recordUrl}`;
  const html = `<p>Hi ${input.signerName},</p><p>Everyone has signed. Your copy of the fully executed record is here:</p><p><a href="${input.recordUrl}">${input.recordUrl}</a></p>`;
  return { subject, html, text };
}

/** Brevo transactional email, matching the convention already used in AAA Next.js
 * apps (see integrated-intelligence/ii-website lib/reply-email.ts and
 * app/api/problem/route.ts) rather than pulling in an SDK. */
export class BrevoEmailSender implements EmailSender {
  private apiKey: string;
  private from: { name: string; email: string };
  private tags: string[];

  constructor(apiKey: string, from: { name: string; email: string }, tags: string[] = []) {
    this.apiKey = apiKey;
    this.from = from;
    this.tags = tags;
  }

  async send(input: { to: { email: string; name: string }; subject: string; html: string; text: string }): Promise<void> {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: this.from,
        to: [input.to],
        subject: input.subject,
        htmlContent: input.html,
        textContent: input.text,
        tags: this.tags,
      }),
    });
    if (!response.ok) {
      throw new Error(`Brevo send failed: ${response.status} ${await response.text()}`);
    }
  }
}
