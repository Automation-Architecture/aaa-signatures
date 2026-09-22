import type { SignatureRequest } from "./types.ts";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** The fully executed record: the original document plus a signatures section with
 * the audit essentials, and the document fingerprint so a reader can independently
 * verify this copy matches what was signed. Send this to every signer once the
 * request completes — retention that doesn't depend on this system staying up. */
export function renderSignedRecord(request: SignatureRequest): string {
  if (request.status !== "completed") throw new Error("renderSignedRecord: request is not completed yet");

  const signatureRows = [...request.signers]
    .sort((a, b) => a.order - b.order)
    .map(
      (signer) =>
        `<p>${escapeHtml(signer.name)} (${escapeHtml(signer.email)}) — signed ${escapeHtml(signer.signedAt ?? "")} UTC</p>`,
    )
    .join("\n");

  const completedAt = request.signers
    .map((s) => s.signedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);

  return (
    request.documentHtml +
    `\n<h2>Signatures</h2>\n${signatureRows}\n` +
    `<p style="font-size:0.8em;color:#666">Document fingerprint (SHA-256): ${request.documentSha256}. ` +
    `Electronically signed record, request ${request.id}, completed ${completedAt}.</p>`
  );
}
