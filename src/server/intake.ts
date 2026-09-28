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
}

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
    },
  };
}
