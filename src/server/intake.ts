// Validation for a contract upload, shared by the admin form and the API. It has no
// database or config dependency, so it can be tested on its own.
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { FormPart } from "./http.ts";

export type SigningOrder = "client_first" | "me_first";

export interface ContractUpload {
  title: string;
  clientName: string;
  clientEmail: string;
  order: SigningOrder;
  filename: string;
  pdf: Buffer;
  pdfSha256: string;
  pageCount: number;
  /** API only: identifies one approved send, so a retry can't create a second request. */
  idempotencyKey?: string;
}

/** The admin form's maxlength limits, enforced here too because the API has no form.
 * Title and names end up in email subjects and bodies, so they must stay small. */
export const FIELD_LIMITS = { title: 200, clientName: 120, clientEmail: 200 } as const;

export type IntakeResult = { ok: true; upload: ContractUpload } | { ok: false; error: string };

export function formField(parts: FormPart[], name: string): string {
  return parts.find((p) => p.name === name && !p.filename)?.data.toString("utf8").trim() ?? "";
}

export async function validateContractUpload(parts: FormPart[]): Promise<IntakeResult> {
  const title = formField(parts, "title");
  const clientName = formField(parts, "clientName");
  const clientEmail = formField(parts, "clientEmail");
  const orderField = formField(parts, "order");
  const file = parts.find((p) => p.name === "pdf" && p.filename);

  if (!title || !clientName || !clientEmail || !file || file.data.length === 0) {
    return { ok: false, error: "Title, client name, client email and a PDF are all required." };
  }
  for (const [name, max] of Object.entries(FIELD_LIMITS)) {
    const length = { title, clientName, clientEmail }[name as keyof typeof FIELD_LIMITS].length;
    if (length > max) return { ok: false, error: `${name} is too long (${length} characters, the limit is ${max}).` };
  }
  const idempotencyKey = formField(parts, "idempotencyKey");
  if (idempotencyKey && !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    return { ok: false, error: "idempotencyKey must be 16 to 128 letters, digits, hyphens or underscores." };
  }
  if (orderField && orderField !== "client_first" && orderField !== "me_first") {
    return { ok: false, error: 'Signing order must be "client_first" or "me_first".' };
  }
  if (!file.data.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return { ok: false, error: "That file is not a PDF." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    return { ok: false, error: "Client email does not look valid." };
  }

  // Do the same work finalization will do (parse, add a page, save) so a PDF that
  // would break the executed record is refused now, not after both parties sign.
  let pageCount: number;
  try {
    const probe = await PDFDocument.load(file.data, { ignoreEncryption: true });
    pageCount = probe.getPageCount();
    if (pageCount === 0) throw new Error("no pages");
    probe.addPage();
    await probe.save();
  } catch {
    return { ok: false, error: "That PDF could not be read. Re-export it and try again." };
  }

  return {
    ok: true,
    upload: {
      title, clientName, clientEmail,
      order: orderField === "me_first" ? "me_first" : "client_first",
      filename: (file.filename ?? "contract.pdf").replace(/[^\w .()-]+/g, "_"),
      pdf: file.data,
      pdfSha256: createHash("sha256").update(file.data).digest("hex"),
      pageCount,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

export interface Party { name: string; email: string }

/** A stored contract, as far as an idempotent retry needs to compare it. */
export interface PersistedContract {
  title: string;
  filename: string;
  pdfSha256: string;
  order: unknown;
  signers: { name: string; email: string; order: number }[];
}

/** The signers a send creates, in signing order. */
export function plannedSigners(upload: Pick<ContractUpload, "clientName" | "clientEmail" | "order">, countersigner: Party): Party[] {
  const client = { name: upload.clientName, email: upload.clientEmail };
  return upload.order === "me_first" ? [countersigner, client] : [client, countersigner];
}

/** The contract-defining fields on which a retried upload differs from the contract its
 * idempotency key already created. Empty means it is the same send. */
export function idempotencyMismatches(upload: ContractUpload, countersigner: Party, stored: PersistedContract): string[] {
  const out: string[] = [];
  if (stored.title !== upload.title) out.push("title");
  if (stored.filename !== upload.filename) out.push("filename");
  if (stored.pdfSha256 !== upload.pdfSha256) out.push("pdf");
  if (stored.order !== upload.order) out.push("order");
  const want = plannedSigners(upload, countersigner);
  const have = [...stored.signers].sort((a, b) => a.order - b.order);
  const sameSigners = have.length === want.length && have.every((s, i) =>
    s.name === want[i]!.name && s.email.toLowerCase() === want[i]!.email.toLowerCase());
  if (!sameSigners) out.push("signers");
  return out;
}
