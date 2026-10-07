import assert from "node:assert/strict";
import test from "node:test";
import { retryPendingNfcSync } from "./nfc-sync.service";

function fixture(nextCheckIn: Date | null) {
  const now = new Date("2026-10-27T15:00:00Z");
  const updates: any[] = [], hardware: any[] = [];
  const row = { id: "nfc", reservationId: "r60", nfcCardId: "card", role: "CLEANING", status: "SCHEDULED",
    retryCount: 0, updatedAt: now, startsAt: new Date("2026-10-27T16:45:00Z"), endsAt: new Date("2026-10-27T20:45:00Z"),
    NfcCard: { ttlockCardId: "123", status: "ASSIGNED" },
    Reservation: { id: "r60", status: "ACTIVE", propertyId: "collores", checkOut: new Date("2026-10-27T16:00:00Z"),
      property: { organizationId: "org", checkOutTime: "12:00", checkInTime: "16:00", timezone: "America/Puerto_Rico", cleaningStartOffsetMinutes: 45 } } };
  const offer = { id: "primary-offer", status: "CONFIRMED", propertyId: "collores", staffMemberId: "primary",
    staffMember: { isActive: true, organizationId: "org", ttlockCardRef: "primary-ref" } };
  let offers = [offer];
  let mappedCardId = "card";
  let tokenHook = () => {};
  let hardwareHook = () => {};
  let intentHook = () => {};
  let receiptHook = () => {};
  let failIntent = false;
  let failAcknowledgementOnce = false;
  const attempts: any[] = [], attemptUpdates: any[] = [], events: string[] = [];
  const queries: any[] = [];
  const db: any = { reservation: { findFirst: async () => nextCheckIn ? { checkIn: nextCheckIn } : null },
    cleaningConfirmation: { findMany: async () => offers },
    staffMember: { findUnique: async () => offers[0]?.staffMember ?? null },
    cleanerNfcProgrammingAttempt: {
      create: async ({ data }: any) => {
        if (failIntent) throw new Error("intent storage unavailable");
        events.push("intent"); attempts.push({ ...data }); intentHook(); return { id: "attempt" };
      },
      update: async ({ data }: any) => {
        if (failAcknowledgementOnce) { failAcknowledgementOnce = false; throw new Error("ack storage unavailable"); }
        events.push(data.state); attemptUpdates.push(data); return {};
      },
    },
    nfcAssignment: { findMany: async (query: any) => {
      queries.push(query);
      return row.startsAt <= query.where.OR[1].OR[0].startsAt.lte && row.endsAt > query.where.OR[1].endsAt.gt ? [row] : [];
    }, updateMany: async () => ({ count: 1 }),
      findFirst: async () => null, update: async ({ data }: any) => { updates.push(data); return {}; } },
    nfcCard: { findFirst: async () => ({ id: mappedCardId }), update: async () => ({}) },
    lock: { findFirst: async () => ({ ttlockLockId: 42 }) },
    $queryRaw: async () => { receiptHook(); return []; },
    $transaction: async (actions: any) => typeof actions === "function" ? actions(db) : Promise.all(actions) };
  let failure = false;
  const dependencies = { getAccessToken: async () => { tokenHook(); return "test"; }, reconcileIssues: async () => {},
    changeCardPeriod: async (args: any) => { events.push("provider"); hardware.push(args); hardwareHook(); if (failure) throw new Error("gateway offline"); return {}; } };
  return { now, row, db, dependencies, updates, hardware, queries, offer, attempts, attemptUpdates, events,
    setOffers: (value: typeof offers) => { offers = value; },
    setCard: (id: string) => { mappedCardId = id; },
    onToken: (hook: () => void) => { tokenHook = hook; },
    onHardware: (hook: () => void) => { hardwareHook = hook; },
    onIntent: (hook: () => void) => { intentHook = hook; },
    onReceipt: (hook: () => void) => { receiptHook = hook; },
    failIntentWrite: () => { failIntent = true; },
    failAckWriteOnce: () => { failAcknowledgementOnce = true; },
    fail: () => { failure = true; } };
}
test("a stale 16:45 cleaner assignment is programmed and persisted as 15:45", async () => {
  const f = fixture(null);
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 1);
  assert.equal(f.hardware[0].endDate, Date.parse("2026-10-27T19:45:00Z"));
  assert.equal(f.updates.find(x => x.status === "ACTIVE").endsAt.toISOString(), "2026-10-27T19:45:00.000Z");
});
test("new early check-in is re-read before programming", async () => {
  const f = fixture(new Date("2026-10-27T18:00:00Z"));
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware[0].endDate, Date.parse("2026-10-27T18:00:00Z"));
});
test("no available window causes no hardware grant and no ACTIVE receipt", async () => {
  const f = fixture(new Date("2026-10-27T16:30:00Z"));
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 0);
  assert.equal(f.updates.some(x => x.status === "ACTIVE"), false);
  assert.match(f.updates.at(-1).lastError, /WINDOW_EMPTY/);
});
test("failed hardware change never acknowledges a repaired window", async () => {
  const f = fixture(null); f.fail();
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.updates.some(x => x.status === "ACTIVE" || x.endsAt), false);
  assert.equal(f.updates.at(-1).status, "FAILED");
});

for (const status of ["SCHEDULED", "FAILED", "PROVISIONING"]) {
  test(`${status} primary card cannot be programmed for a confirmed backup`, async () => {
    const f = fixture(null);
    f.row.status = status;
    f.setOffers([{ ...f.offer, id: "backup-offer" }]);
    f.setCard("backup-card");
    const result = await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
    assert.equal(result.activated, 0);
    assert.equal(f.hardware.length, 0);
    assert.match(f.updates.at(-1).lastError, /CLEANER_ACCESS_CARD_MISMATCH/);
    assert.equal(f.updates.at(-1).lastError.startsWith("RETRYABLE:"), false);
  });
}
test("no confirmed cleaner prevents programming obsolete access", async () => {
  const f = fixture(null); f.setOffers([]);
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 0);
  assert.match(f.updates.at(-1).lastError, /AUTHORITY_CHANGED/);
});
test("pending backup prevents programming prior cleaner access", async () => {
  const f = fixture(null); f.setOffers([{ ...f.offer, status: "PENDING" }]);
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 0);
});
test("ambiguous current offers prevent programming", async () => {
  const f = fixture(null); f.setOffers([f.offer, { ...f.offer, id: "other" }]);
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 0);
});
test("cancellation while obtaining provider authorization prevents physical write", async () => {
  const f = fixture(null); f.onToken(() => f.setOffers([]));
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 0);
  assert.equal(f.updates.some(x => x.status === "ACTIVE"), false);
});
test("reassignment during provider write does not record obsolete access as ACTIVE", async () => {
  const f = fixture(null); f.onHardware(() => f.setOffers([{ ...f.offer, id: "new-offer" }]));
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 1);
  assert.equal(f.updates.some(x => x.status === "ACTIVE"), false);
  assert.match(f.updates.at(-1).lastError, /AUTHORITY_UNVERIFIED_AFTER_PROGRAMMING/);
});
test("primary remains scheduled before the two-hour horizon", async () => {
  const f = fixture(null);
  const result = await retryPendingNfcSync(f.db, new Date("2026-10-27T14:44:00Z"), {}, f.dependencies);
  assert.equal(result.activated, 0);
  assert.equal(f.hardware.length, 0);
  assert.equal(f.updates.length, 0);
});
test("backup is programmed at the two-hour horizon with future entry window", async () => {
  const f = fixture(null);
  f.setOffers([{ ...f.offer, id: "backup-offer" }]);
  f.row.nfcCardId = "backup-card"; f.setCard("backup-card");
  const result = await retryPendingNfcSync(f.db, new Date("2026-10-27T14:45:00Z"), {}, f.dependencies);
  assert.equal(result.activated, 1);
  assert.equal(f.hardware[0].startDate, Date.parse("2026-10-27T16:45:00Z"));
  assert.equal(f.hardware[0].endDate, Date.parse("2026-10-27T19:45:00Z"));
});

test("exact cleaner programming target is durable before the provider call", async () => {
  const f = fixture(null);
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.attempts.length, 1);
  assert.deepEqual(f.attempts[0], { nfcAssignmentId: "nfc", confirmationId: "primary-offer",
    attemptNumber: 1, organizationId: "org", ttlockLockId: 42, ttlockCardId: 123,
    startsAt: new Date("2026-10-27T16:45:00Z"), endsAt: new Date("2026-10-27T19:45:00Z"), state: "PREPARED" });
  assert.deepEqual(f.events, ["intent", "provider", "ACKNOWLEDGED"]);
  assert.ok(f.attemptUpdates[0].acknowledgedAt instanceof Date);
});
test("failed intent persistence prevents the physical command", async () => {
  const f = fixture(null); f.failIntentWrite();
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 0);
  assert.equal(f.updates.some(x => x.status === "ACTIVE"), false);
});
test("cancellation during intent persistence leaves ABORTED evidence without programming", async () => {
  const f = fixture(null); f.onIntent(() => f.setOffers([]));
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 0);
  assert.equal(f.attemptUpdates.at(-1).state, "ABORTED");
});
test("provider failure retains exact target as UNCERTAIN", async () => {
  const f = fixture(null); f.fail();
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.attemptUpdates.at(-1).state, "UNCERTAIN");
  assert.equal(f.attemptUpdates.at(-1).acknowledgedAt, undefined);
  assert.equal(f.attempts[0].ttlockLockId, 42);
});
test("successful provider response remains acknowledged when assignment changes", async () => {
  const f = fixture(null); f.onHardware(() => f.setOffers([]));
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.attemptUpdates.at(-1).state, "ACKNOWLEDGED");
  assert.match(f.attemptUpdates.at(-1).lastError, /AUTHORITY_UNVERIFIED_AFTER_PROGRAMMING/);
  assert.equal(f.updates.some(x => x.status === "ACTIVE"), false);
});
test("provider acknowledgement persistence failure never makes the grant ACTIVE", async () => {
  const f = fixture(null); f.failAckWriteOnce();
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 1);
  assert.equal(f.attemptUpdates.at(-1).state, "ACKNOWLEDGED");
  assert.equal(f.updates.some(x => x.status === "ACTIVE"), false);
});

test("withdrawal before final receipt lock prevents ACTIVE persistence after provider success", async () => {
  const f = fixture(null);
  f.onReceipt(() => f.setOffers([]));
  const result = await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 1);
  assert.equal(result.activated, 0);
  assert.equal(f.updates.some(u => u.status === "ACTIVE"), false);
  assert.equal(f.attemptUpdates.at(-1).state, "ACKNOWLEDGED");
});
