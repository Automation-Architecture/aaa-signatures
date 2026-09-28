import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { validateContractUpload } from "../src/server/intake.ts";
import { bearerTokenMatches, type FormPart } from "../src/server/http.ts";

async function onePagePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return Buffer.from(await pdf.save());
}

function field(name: string, value: string): FormPart {
  return { name, data: Buffer.from(value) };
}

async function upload(overrides: Record<string, string> = {}, pdf?: Buffer): Promise<FormPart[]> {
  const values = { title: "SOW", clientName: "Ada Client", clientEmail: "ada@example.com", ...overrides };
  return [
    ...Object.entries(values).map(([k, v]) => field(k, v)),
    { name: "pdf", filename: "sow v2.pdf", contentType: "application/pdf", data: pdf ?? (await onePagePdf()) },
  ];
}

test("a complete upload is accepted and described", async () => {
  const result = await validateContractUpload(await upload({ order: "me_first" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.upload.order, "me_first");
  assert.equal(result.upload.pageCount, 1);
  assert.match(result.upload.pdfSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.upload.filename, "sow v2.pdf");
});

test("signing order defaults to client first", async () => {
  const result = await validateContractUpload(await upload());
  assert.equal(result.ok && result.upload.order, "client_first");
});

test("an unknown signing order is refused rather than guessed", async () => {
  const result = await validateContractUpload(await upload({ order: "brad_first" }));
  assert.equal(result.ok, false);
});

test("missing fields, bad email, non-PDF and unreadable PDF are refused", async () => {
  assert.equal((await validateContractUpload(await upload({ title: "" }))).ok, false);
  assert.equal((await validateContractUpload(await upload({ clientEmail: "not-an-email" }))).ok, false);
  assert.equal((await validateContractUpload(await upload({}, Buffer.from("hello")))).ok, false);
  assert.equal((await validateContractUpload(await upload({}, Buffer.from("%PDF-1.7 garbage")))).ok, false);
});

test("bearer key must match exactly, and an unset key never matches", () => {
  const key = "k".repeat(40);
  assert.equal(bearerTokenMatches({ headers: { authorization: `Bearer ${key}` } }, key), true);
  assert.equal(bearerTokenMatches({ headers: { authorization: `bearer ${key}` } }, key), true);
  assert.equal(bearerTokenMatches({ headers: { authorization: `Bearer ${key}x` } }, key), false);
  assert.equal(bearerTokenMatches({ headers: {} }, key), false);
  assert.equal(bearerTokenMatches({ headers: { authorization: "Bearer " } }, ""), false);
  assert.equal(bearerTokenMatches({ headers: { authorization: "Bearer anything" } }, ""), false);
});

test("fields longer than the admin form allows are refused", async () => {
  assert.equal((await validateContractUpload(await upload({ title: "t".repeat(201) }))).ok, false);
  assert.equal((await validateContractUpload(await upload({ clientName: "n".repeat(121) }))).ok, false);
  assert.equal((await validateContractUpload(await upload({ clientEmail: `${"a".repeat(196)}@b.co` }))).ok, false);
  assert.equal((await validateContractUpload(await upload({ title: "t".repeat(200) }))).ok, true);
});
