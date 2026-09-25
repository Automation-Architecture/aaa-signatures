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
  adminPassword: required("ADMIN_PASSWORD"),
  /** HMAC key for the admin session cookie. */
  sessionSecret: required("SESSION_SECRET"),
  /** The operator, who countersigns every contract. */
  adminSigner: {
    name: process.env.ADMIN_SIGNER_NAME ?? "Brad Wilcox",
    email: process.env.ADMIN_SIGNER_EMAIL ?? "brad@automationarchitecture.ai",
  },
  brevoApiKey: process.env.BREVO_API_KEY ?? "",
  emailFrom: {
    name: process.env.EMAIL_FROM_NAME ?? "Automation Architecture AI",
    email: process.env.EMAIL_FROM_EMAIL ?? "contracts@automationarchitecture.ai",
  },
  maxUploadBytes: 25 * 1024 * 1024,
  linkExpiresInDays: 14,
};
