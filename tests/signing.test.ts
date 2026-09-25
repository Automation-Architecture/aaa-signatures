import test from "node:test";
import assert from "node:assert/strict";
import { createSignatureRequest, issueSignerToken } from "../src/request.ts";
import { getSigningView, captureSignature, SigningError } from "../src/sign.ts";
import { renderSignedRecord } from "../src/render.ts";
import type { AuditEvent, RequestStatus, SignatureRequest, SignatureStore, Signer } from "../src/types.ts";

class InMemoryStore implements SignatureStore {
  requests = new Map<string, SignatureRequest>();
  auditEvents: AuditEvent[] = [];

  async createRequest(request: SignatureRequest) {
    this.requests.set(request.id, structuredClone(request));
  }
  async getRequest(id: string) {
    const r = this.requests.get(id);
    return r ? structuredClone(r) : null;
  }
  async updateSigner(requestId: string, signerId: string, patch: Partial<Signer>) {
    const r = this.requests.get(requestId)!;
    const signer = r.signers.find((s) => s.id === signerId)!;
    if (patch.status === "signed" && signer.status !== "pending") throw new SigningError("already_signed", "already signed");
    Object.assign(signer, patch);
  }
  async updateRequestStatus(requestId: string, status: RequestStatus) {
    this.requests.get(requestId)!.status = status;
  }
  async appendAuditEvent(event: AuditEvent) {
    this.auditEvents.push(event);
  }
}

async function makeTwoSignerRequest() {
  const store = new InMemoryStore();
  const { request, rawTokens } = await createSignatureRequest(store, {
    title: "Test Release",
    documentHtml: "<p>Terms</p>",
    signers: [
      { name: "Guest Person", email: "guest@example.com" },
      { name: "Host Person", email: "host@example.com" },
    ],
  });
  return { store, request, rawTokens };
}

test("guest cannot sign before viewing, and viewing alone never signs", async () => {
  const { store, request, rawTokens } = await makeTwoSignerRequest();
  const guest = request.signers[0];
  const token = rawTokens.get(guest.id)!;

  await getSigningView(store, { requestId: request.id, signerId: guest.id, token });
  const after = await store.getRequest(request.id);
  assert.equal(after!.signers[0].status, "pending", "a GET/view must not sign anything");
  assert.ok(store.auditEvents.some((e) => e.type === "viewed"));
});

test("host cannot sign out of order", async () => {
  const { store, request, rawTokens } = await makeTwoSignerRequest();
  const host = request.signers[1];
  const token = rawTokens.get(host.id)!;

  await assert.rejects(
    () =>
      captureSignature(store, {
        requestId: request.id,
        signerId: host.id,
        token,
        typedLegalName: "Host Person",
        agreedToElectronicSignature: true,
        documentSha256Seen: request.documentSha256,
      }),
    (err: unknown) => err instanceof SigningError && err.code === "not_your_turn",
  );
});

test("wrong token is rejected even for the right signer id", async () => {
  const { store, request } = await makeTwoSignerRequest();
  const guest = request.signers[0];

  await assert.rejects(
    () => getSigningView(store, { requestId: request.id, signerId: guest.id, token: "not-the-real-token" }),
    (err: unknown) => err instanceof SigningError && err.code === "invalid_token",
  );
});

test("a changed document is refused at capture time", async () => {
  const { store, request, rawTokens } = await makeTwoSignerRequest();
  const guest = request.signers[0];
  const token = rawTokens.get(guest.id)!;

  await assert.rejects(() =>
    captureSignature(store, {
      requestId: request.id,
      signerId: guest.id,
      token,
      typedLegalName: "Guest Person",
      agreedToElectronicSignature: true,
      documentSha256Seen: "0000000000000000000000000000000000000000000000000000000000000",
    }),
  );
});

test("full two-signer flow completes and renders a record with both signatures", async () => {
  const { store, request, rawTokens } = await makeTwoSignerRequest();
  const [guest, host] = request.signers;

  const first = await captureSignature(store, {
    requestId: request.id,
    signerId: guest.id,
    token: rawTokens.get(guest.id)!,
    typedLegalName: "Guest Person",
    agreedToElectronicSignature: true,
    documentSha256Seen: request.documentSha256,
  });
  assert.equal(first.completed, false);
  assert.equal(first.nextSigner?.id, host.id);

  const second = await captureSignature(store, {
    requestId: request.id,
    signerId: host.id,
    token: rawTokens.get(host.id)!,
    typedLegalName: "Host Person",
    agreedToElectronicSignature: true,
    documentSha256Seen: request.documentSha256,
  });
  assert.equal(second.completed, true);

  const finalRequest = await store.getRequest(request.id);
  const record = renderSignedRecord(finalRequest!);
  assert.match(record, /Guest Person/);
  assert.match(record, /Host Person/);
  assert.match(record, new RegExp(request.documentSha256));
});

test("a freshly issued token lets a countersigner be invited after the fact", async () => {
  const { store, request, rawTokens } = await makeTwoSignerRequest();
  const [guest, host] = request.signers;

  await captureSignature(store, {
    requestId: request.id,
    signerId: guest.id,
    token: rawTokens.get(guest.id)!,
    typedLegalName: "Guest Person",
    agreedToElectronicSignature: true,
    documentSha256Seen: request.documentSha256,
  });

  // The host's creation-time token is intentionally never used — this mints a fresh
  // one, the way the completion handler does right before sending the invite.
  const rotatedToken = await issueSignerToken(store, request.id, host.id);

  const view = await getSigningView(store, { requestId: request.id, signerId: host.id, token: rotatedToken });
  assert.equal(view.signer.id, host.id);
});

test("signing without agreeing to the electronic-records disclosure is rejected", async () => {
  const { store, request, rawTokens } = await makeTwoSignerRequest();
  const guest = request.signers[0];

  await assert.rejects(() =>
    captureSignature(store, {
      requestId: request.id,
      signerId: guest.id,
      token: rawTokens.get(guest.id)!,
      typedLegalName: "Guest Person",
      agreedToElectronicSignature: false,
      documentSha256Seen: request.documentSha256,
    }),
  );
});

test("two concurrent submissions of the same signing form record only one signature", async () => {
  const { store, request, rawTokens } = await makeTwoSignerRequest();
  const guest = request.signers[0];
  const input = {
    requestId: request.id,
    signerId: guest.id,
    token: rawTokens.get(guest.id)!,
    typedLegalName: "Guest Person",
    agreedToElectronicSignature: true,
    documentSha256Seen: request.documentSha256,
  };

  const results = await Promise.allSettled([captureSignature(store, input), captureSignature(store, input)]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(fulfilled.length, 1, "exactly one submission should succeed");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof SigningError && rejected[0].reason.code === "already_signed");
  assert.equal(store.auditEvents.filter((e) => e.type === "signed").length, 1, "only one signed audit event");
});
