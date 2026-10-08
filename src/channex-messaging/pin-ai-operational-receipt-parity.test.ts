import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { createAutoRepository, type AIJob } from "./pin-ai-auto.repository.js";
import { createAutomaticResponder } from "./pin-ai-auto.service.js";
import type { DraftHistory } from "./pin-ai-draft.js";

const organizationId = "org-a", propertyId = "prop-a";
const threadId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const guestId = "33333333-3333-4333-8333-333333333333";
const hostId = "44444444-4444-4444-8444-444444444444";
const since = new Date("2026-10-01T00:00:00Z");

type OperationalReceipt = {
  organizationId: string; propertyId: string; to: string;
  channel: string; provider: string; status: string;
  communicationType: string; providerMessageId: string | null; body: string;
};
const receipt = (overrides: Partial<OperationalReceipt> = {}): OperationalReceipt => ({
  organizationId, propertyId, to: threadId,
  channel: "channex", provider: "channex", status: "SENT",
  communicationType: "GUEST_ACCESS_PASSCODE", providerMessageId: operationId,
  body: JSON.stringify({ kind: "PIN_GO_OTA_OPERATIONAL_DELIVERY" }),
  ...overrides,
});

function fixture(rows: OperationalReceipt[], aiIds: string[] = []) {
  const queries: any[] = [];
  const db = {
    channexHostMessageSend: { findMany: async () => aiIds.map(id => ({ response: { id } })) },
    messageLog: { findMany: async ({ where, take }: any) => {
      queries.push(where);
      return rows.filter(row =>
        row.organizationId === where.organizationId &&
        row.propertyId === where.propertyId &&
        row.to === where.to &&
        row.channel === where.channel &&
        row.provider === where.provider &&
        row.status === where.status &&
        where.communicationType.in.includes(row.communicationType) &&
        where.providerMessageId.in.includes(row.providerMessageId) &&
        where.OR.some((condition: any) => row.body.includes(condition.body.contains))
      ).slice(0, take).map(row => ({ providerMessageId: row.providerMessageId }));
    } },
  };
  return { repo: createAutoRepository(db as unknown as PrismaClient), queries };
}

test("trusted Channex operational receipts are owned by Pin&Go, not the host", async () => {
  for (const kind of ["PIN_GO_AIRBNB_DELIVERY", "PIN_GO_OTA_OPERATIONAL_DELIVERY"]) {
    const f = fixture([receipt({ body: JSON.stringify({ kind }) })]);
    const own = await f.repo.ownMessageIds({ organizationId, propertyId, threadId }, [operationId]);
    assert.deepEqual([...own], [operationId]);
    assert.equal(f.queries[0].to, threadId);
    assert.deepEqual(f.queries[0].communicationType.in, [
      "PRECHECKIN", "GUEST_ACCESS_PASSCODE", "CHECKOUT",
    ]);
  }
});

test("previous Pin AI receipts still count alongside operational messages", async () => {
  const f = fixture([receipt()], [hostId]);
  const own = await f.repo.ownMessageIds({ organizationId, propertyId, threadId }, [operationId, hostId]);
  assert.equal(own.has(operationId), true);
  assert.equal(own.has(hostId), true);
});

test("incorrect scope, uncertain receipts and other message types never bypass host takeover", async () => {
  for (const change of [
    { organizationId: "other-org" }, { propertyId: "other-property" },
    { to: "other-thread" }, { channel: "sms" }, { provider: "twilio" },
    { status: "CHANNEX_UNKNOWN" }, { communicationType: "CLEANING_START" },
    { providerMessageId: "other-message" }, { body: JSON.stringify({ kind: "HOST_MANUAL_MESSAGE" }) },
  ]) {
    const f = fixture([receipt(change)]);
    const own = await f.repo.ownMessageIds({ organizationId, propertyId, threadId }, [operationId]);
    assert.equal(own.has(operationId), false, JSON.stringify(change));
  }
});

function history(host = false): DraftHistory {
  const items: DraftHistory["items"] = [
    { id: operationId, text: "Tu código de acceso está listo", sender: "property",
      insertedAt: "2026-10-02T15:00:00Z", attachments: [] },
  ];
  if (host) items.push({ id: hostId, text: "Mensaje del host", sender: "property",
    insertedAt: "2026-10-02T15:01:00Z", attachments: [] });
  items.push({ id: guestId, text: "Gracias, ¿hay estacionamiento?", sender: "guest",
    insertedAt: "2026-10-02T15:02:00Z", attachments: [] });
  return {
    thread: { id: threadId, title: "Test", provider: "BookingCom", isClosed: false,
      bookingId: "55555555-5555-4555-8555-555555555555", messageCount: items.length,
      updatedAt: "2026-10-02T15:02:00Z", lastMessage: null },
    items, page: 1, limit: 25, total: items.length,
  };
}
const job = {
  id: "inbound", organizationId, propertyId, threadId, messageId: guestId,
  since, status: "QUEUED", reason: null, leaseToken: "lease",
  leaseUntil: new Date("2030-01-01T00:00:00Z"),
  receivedAt: since, updatedAt: since,
} as AIJob;

test("a Pin&Go access message does not pause a following Pin AI reply", async () => {
  const f = fixture([receipt()]);
  let mode = "AUTO", sent = 0;
  const outcomes: string[] = [];
  const process = createAutomaticResponder({
    repository: {
      state: async () => ({ mode, leaseToken: "lease" }) as any,
      ownMessageIds: f.repo.ownMessageIds,
      fence: async () => mode === "AUTO",
      finish: async (_job, status, reason) => {
        outcomes.push(status + ":" + reason);
        if (status === "NEEDS_HOST" || status === "UNKNOWN") mode = "HUMAN";
      },
    },
    enabled: () => true, messages: async () => history(),
    generate: async input => ({ basedOnMessageId: input.messageId, text: "Sí",
      requiresHumanReview: false, sent: false }),
    send: async () => { sent++; },
  });
  await process(job);
  assert.equal(mode, "AUTO");
  assert.equal(sent, 1);
  assert.deepEqual(outcomes, ["SENT:CHANNEX_ACCEPTED"]);
});

test("a genuine host reply still pauses Pin AI following a Pin&Go access message", async () => {
  const f = fixture([receipt()]);
  const outcomes: string[] = [];
  const process = createAutomaticResponder({
    repository: {
      state: async () => ({ mode: "AUTO", leaseToken: "lease" }) as any,
      ownMessageIds: f.repo.ownMessageIds,
      fence: async () => true,
      finish: async (_job, status, reason) => { outcomes.push(status + ":" + reason); },
    },
    enabled: () => true, messages: async () => history(true),
    generate: async () => { throw Error("AI must never be called"); },
    send: async () => { throw Error("Channex must never be called"); },
  });
  await process(job);
  assert.deepEqual(outcomes, ["NEEDS_HOST:HOST_TAKEOVER"]);
});
