// Runtime configuration for the hosted contract-signing app (contract.automationarchitecture.ai).
// Every value comes from the environment; nothing is defaulted that would be wrong in production.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Public origin used in emailed links, e.g. https://contract.automationarchitecture.ai */
  baseUrl: (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ""),
  databaseUrl: required("DATABASE_URL"),
  /** Single-operator admin: the upload page is behind this password. */
  /** Fallback login, used only while Google sign-in isn't configured. */
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  /** Google sign-in, matching the other internal AAA tools (invoices): a Google
   * OAuth web client on the workspace's Internal consent screen, and an allowlist. */
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    hostedDomain: process.env.GOOGLE_HOSTED_DOMAIN ?? "automationarchitecture.ai",
    tokenUrl: process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
  },
  allowedEmails: (process.env.ALLOWED_EMAILS ?? "brad@automationarchitecture.ai")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  /** HMAC key for the admin session cookie. */
  sessionSecret: required("SESSION_SECRET"),
  /** The operator, who countersigns every contract. */
  adminSigner: {
    name: process.env.ADMIN_SIGNER_NAME ?? "Brad Wilcox",
    email: process.env.ADMIN_SIGNER_EMAIL ?? "brad@automationarchitecture.ai",
  },
  /** Google Workspace SMTP: the mailbox that owns the contract@ alias, with an app password. */
  smtp: {
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT ?? 465),
    user: process.env.SMTP_USER ?? "",
    password: process.env.SMTP_PASSWORD ?? "",
  },
  emailFrom: {
    name: process.env.EMAIL_FROM_NAME ?? "Automation Architecture AI",
    email: process.env.EMAIL_FROM_EMAIL ?? "contract@automationarchitecture.ai",
  },
  /** Local development only: log emails instead of sending. Never set in production,
   * because the logged invite contains a live signing link. */
  emailDevLog: process.env.EMAIL_DEV_LOG === "1",
  maxUploadBytes: 25 * 1024 * 1024,
  linkExpiresInDays: 14,
};

export const googleEnabled = Boolean(config.google.clientId && config.google.clientSecret);
if (!googleEnabled && !config.adminPassword) {
  throw new Error("configure Google sign-in (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) or set ADMIN_PASSWORD");
}
