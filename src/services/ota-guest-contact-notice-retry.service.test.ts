import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { retryGuestContactHostNotices } from "./ota-guest-contact-notice-retry.service";

function fixture(overrides: Record<string, any> = {}) {
  const updates: any[] = [], sends: any[] = [], queries: any[] = [];
  const message = { id: "msg", reservationId: "res", propertyId: "prop", organizationId: "org", to: "host@example.com" };
  const reservation = { id: "res", reservationNumber: "PG-1", source: "Airbnb", status: "ACTIVE", checkOut: new Date("2100-01-01"), guestEmail: null, guestPhone: "+17875550100", property: { name: "Property" } };
  const db = {
    messageLog: {
      findMany: async (query: any) => { queries.push(query); return [{ ...message, ...overrides.message }]; },
      findFirst: async () => overrides.alreadySent ?? null,
      update: async (query: any) => { updates.push(query); return query; },
    },
    reservation: { findFirst: async (query: any) => {
      queries.push(query); return overrides.reservation === null ? null : { ...reservation, ...overrides.reservation };
    } },
    operationalIssue: { findUnique: async () => ({ workflowState: overrides.workflowState ?? "ACTION_REQUIRED" }) },
    dashboardUser: { findMany: async () => overrides.recipients ?? [{ email: "host@example.com", fullName: "Host" }] },
  };
  const send = async (input: any) => {
    sends.push(input);
    if (overrides.error) throw new Error(overrides.error);
    return overrides.response ?? { data: { id: "provider-id" } };
  };
  return { db: db as any, send: send as any, updates, sends, queries };
}
const options = { maxRetries: 3, batchSize: 20 };

test("retries original failed host row with current fields and provider idempotency", async () => {
  const f = fixture();
  assert.deepEqual(await retryGuestContactHostNotices(f.db, options, f.send), { sent: 1, failed: 0, skipped: 0 });
  assert.deepEqual(f.sends[0].missingFields, ["EMAIL"]);
  assert.equal(f.sends[0].to, "host@example.com");
  assert.equal(f.sends[0].idempotencyKey, "guest-contact-recovery:res:host@example.com");
  assert.equal(f.updates[0].where.id, "msg");
  assert.equal(f.updates[0].data.status, "SENT");
  assert.equal(f.updates[0].data.providerMessageId, "provider-id");
  assert.deepEqual(f.updates[0].data.retryCount, { increment: 1 });
  assert.equal(f.updates[0].data.providerDeliveryStatus, null);
  assert.equal(f.queries[0].where.retryCount.lt, 3);
  assert.equal(f.queries[0].where.status, "FAILED");
  assert.deepEqual(f.queries[1].where, { id: "res", propertyId: "prop", externalProvider: "CHANNEX", property: { organizationId: "org" } });
});

for (const [name, override] of [
  ["missing tenant", { message: { organizationId: null } }],
  ["reservation outside tenant", { reservation: null }],
  ["cancelled reservation", { reservation: { status: "CANCELLED" } }],
  ["finished stay", { reservation: { checkOut: new Date("2000-01-01") } }],
  ["contact already complete", { reservation: { guestEmail: "guest@example.com" } }],
  ["resolved issue", { workflowState: "RESOLVED" }],
  ["removed recipient", { recipients: [] }],
  ["already sent notice", { alreadySent: { id: "other" } }],
] as const) {
  test(`does not resend ${name}`, async () => {
    const f = fixture(override);
    assert.deepEqual(await retryGuestContactHostNotices(f.db, options, f.send), { sent: 0, failed: 0, skipped: 1 });
    assert.equal(f.sends.length, 0);
    assert.equal(f.updates[0].data.status, "SKIPPED");
  });
}

test("counts failed attempts and retains provider error without fabricating delivery", async () => {
  const f = fixture({ error: "Provider unavailable" });
  assert.deepEqual(await retryGuestContactHostNotices(f.db, options, f.send), { sent: 0, failed: 1, skipped: 0 });
  assert.equal(f.updates[0].data.status, "FAILED");
  assert.match(f.updates[0].data.error, /Provider unavailable/);
  assert.deepEqual(f.updates[0].data.retryCount, { increment: 1 });
});

test("console fallback without provider acceptance cannot be recorded as sent", async () => {
  const f = fixture({ response: { ok: true, mode: "console" } });
  assert.equal((await retryGuestContactHostNotices(f.db, options, f.send)).failed, 1);
  assert.match(f.updates[0].data.error, /PROVIDER_ACCEPTANCE_MISSING/);
});

test("deployed retry worker calls contact notice retries independently each tick", async () => {
  const worker = await readFile(new URL("../workers/message.retry.worker.ts", import.meta.url), "utf8");
  assert.match(worker, /await retryGuestContactHostNotices\(prisma,\s*\{\s*maxRetries: MAX_RETRIES, batchSize: BATCH_SIZE/);
});
