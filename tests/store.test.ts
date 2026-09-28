import test from "node:test";
import assert from "node:assert/strict";
import { PgStore } from "../src/server/store.ts";
import type { SignatureRequest } from "../src/types.ts";

// A stand-in pool that records statements, so the transaction shape can be checked
// without a database. `failOn` makes the first statement containing it throw.
function fakeStore(failOn?: string) {
  const log: string[] = [];
  const client = {
    async query(sql: string) {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (failOn && sql.includes(failOn)) throw new Error("boom");
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgStore("postgres://localhost/unused");
  (store as unknown as { pool: unknown }).pool = { connect: async () => client };
  return { store, log };
}

const request: SignatureRequest = {
  id: "r1", title: "SOW", documentHtml: "<p>x</p>", documentSha256: "0".repeat(64), createdAt: new Date(0).toISOString(),
  status: "pending", metadata: { idempotencyKey: "k".repeat(32) },
  signers: [{ id: "s1", name: "Ada", email: "ada@example.com", order: 0, status: "pending", tokenHash: "h", tokenExpiresAt: new Date(0).toISOString() }],
};
const document = { filename: "sow.pdf", pdf: Buffer.from("%PDF-"), pdfSha256: "1".repeat(64) };

test("a request and its document are written in one transaction", async () => {
  const { store, log } = fakeStore();
  await store.createRequest(request, document);
  assert.deepEqual(log, [
    "begin", "insert into signature_requests", "insert into signature_signers", "insert into contract_documents", "commit",
  ]);
});

test("if the document insert fails, the request is rolled back with it", async () => {
  const { store, log } = fakeStore("contract_documents");
  await assert.rejects(store.createRequest(request, document), /boom/);
  assert.equal(log.at(-1), "rollback");
  assert.ok(!log.includes("commit"));
});
