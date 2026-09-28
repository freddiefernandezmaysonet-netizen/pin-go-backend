import assert from "node:assert/strict";
import test from "node:test";
import {
  materializeCleaningWorkSnapshot, CleaningWorkSnapshotError,
  type CleaningWorkContext, type CleaningWorkScope,
  type CleaningWorkSnapshot, type CleaningWorkSnapshotStore,
} from "./cleaning-work-snapshot.service.js";

const scope: CleaningWorkScope = {
  organizationId: "org-a", propertyId: "property-a", reservationId: "reservation-a",
  staffMemberId: "staff-a", confirmationId: "confirmation-a",
};
const TEST_NOW = new Date("2026-09-28T15:00:00.000Z");
const context: CleaningWorkContext = {
  reservationStatus: "ACTIVE", propertyStatus: "ACTIVE", cleaningNfcEnabled: true,
  staffActive: true, assignmentActive: true, confirmationStatus: "CONFIRMED",
  checkOut: new Date("2026-09-28T15:00:00.000Z"), cleaningStartOffsetMinutes: 30,
  durationCommitmentMinutes: 120, startConfirmationGraceMinutes: 30, followupGraceMinutes: 15,
};
function fixture(changes: Partial<CleaningWorkContext> = {}) {
  let source: CleaningWorkContext | null = { ...context, ...changes };
  let work: CleaningWorkSnapshot | null = null;
  let competingWork = false;
  let writes = 0;
  let transactions = 0;
  const store: CleaningWorkSnapshotStore = {
    async transaction(run) {
      transactions += 1;
      return run({
        async loadContext(actual) { assert.deepEqual(actual, scope); return source; },
        async findExisting() { return work; },
        async hasOtherCurrentWork() { return competingWork; },
        async create(snapshot) {
          writes += 1;
          work = { ...snapshot, id: "work-a", timingConsentVersion: null, timingConsentAcceptedAt: null,
            startConfirmedAt: null, completionConfirmedAt: null, cancelledAt: null, supersededAt: null };
          return work;
        },
      });
    },
  };
  return { store, get work() { return work; }, get writes() { return writes; },
    get transactions() { return transactions; },
    setContext(next: CleaningWorkContext | null) { source = next; },
    setWork(next: CleaningWorkSnapshot) { work = next; },
    compete() { competingWork = true; },
  };
}
async function rejects(f: ReturnType<typeof fixture>, code: string) {
  await assert.rejects(materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW),
    (error: unknown) => error instanceof CleaningWorkSnapshotError && error.code === code);
  assert.equal(f.writes, 0);
}

test("copies Staff timings, checkout offset and scoped binding; creates no confirmations", async () => {
  const f = fixture();
  const r = await materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW);
  assert.equal(r.outcome, "CREATED");
  assert.equal(r.work?.scheduledStartAt.toISOString(), "2026-09-28T15:30:00.000Z");
  assert.equal(r.work?.durationCommitmentMinutes, 120);
  assert.equal(r.work?.startConfirmationGraceMinutes, 30);
  assert.equal(r.work?.followupGraceMinutes, 15);
  assert.equal(r.work?.confirmationId, scope.confirmationId);
  assert.equal(r.work?.startConfirmedAt, null);
  assert.equal(r.work?.completionConfirmedAt, null);
  assert.equal(r.timingCommitmentAccepted, false);
  assert.equal(r.propertyReady, false);
  assert.equal(f.writes, 1);
});
test("repeat invocation replays one record without changing saved Staff timings", async () => {
  const f = fixture();
  const first = await materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW);
  f.setContext({ ...context, durationCommitmentMinutes: 240, startConfirmationGraceMinutes: 60 });
  const second = await materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW);
  assert.equal(second.outcome, "REPLAYED");
  assert.deepEqual(second.work, first.work);
  assert.equal(f.writes, 1);
});
test("no configured duration means no invented commitment and no work created", async () => {
  const f = fixture({ durationCommitmentMinutes: null });
  assert.equal((await materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW)).outcome, "NOT_CONFIGURED");
  assert.equal(f.writes, 0);
});
test("cross-tenant, missing assignment or mismatched confirmation is rejected", async () => {
  const f = fixture(); f.setContext(null);
  await rejects(f, "CLEANING_WORK_OUT_OF_SCOPE");
});
for (const field of ["reservationStatus", "propertyStatus"] as const) {
  test(`inactive ${field} cannot create work`, async () => {
    await rejects(fixture({ [field]: "CANCELLED" }), "CLEANING_WORK_INACTIVE_CONTEXT");
  });
}
for (const field of ["staffActive", "assignmentActive"] as const) {
  test(`false ${field} cannot create work`, async () => {
    await rejects(fixture({ [field]: false }), "CLEANING_WORK_INACTIVE_CONTEXT");
  });
}
test("NFC remains required by the existing cleaner flow", async () => {
  await rejects(fixture({ cleaningNfcEnabled: false }), "CLEANING_WORK_NFC_FLOW_DISABLED");
});
for (const status of ["PENDING", "DECLINED", "EXPIRED", ""]) {
  test(`${status || "empty"} confirmation cannot create a work snapshot`, async () => {
    await rejects(fixture({ confirmationStatus: status }), "CLEANING_WORK_CONFIRMATION_REQUIRED");
  });
}
for (const [field, value] of [
  ["cleaningStartOffsetMinutes", -1], ["cleaningStartOffsetMinutes", 1441],
  ["durationCommitmentMinutes", 0], ["durationCommitmentMinutes", 15.5],
  ["startConfirmationGraceMinutes", 4], ["followupGraceMinutes", 241],
] as const) {
  test(`invalid ${field}=${value} is rejected before writes`, async () => {
    await rejects(fixture({ [field]: value }), "CLEANING_WORK_INVALID_TIMING");
  });
}
test("invalid checkout cannot produce an invalid schedule", async () => {
  await rejects(fixture({ checkOut: new Date("invalid") }), "CLEANING_WORK_INVALID_DATE");
});
test("a different current cleaner requires explicit reassignment, not a second active work", async () => {
  const f = fixture(); f.compete();
  await rejects(f, "CLEANING_WORK_REASSIGNMENT_REQUIRES_REVIEW");
});
for (const terminal of ["cancelledAt", "supersededAt", "completionConfirmedAt"] as const) {
  test(`${terminal} never reopens a work record`, async () => {
    const f = fixture(); const r = await materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW);
    assert.ok(r.work);
    f.setWork({ ...r.work, [terminal]: new Date("2026-09-28T17:00:00Z") });
    assert.equal((await materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW)).outcome, "EXISTING_CLOSED");
    assert.equal(f.writes, 1);
  });
}
test("checkout rescheduling cannot silently rewrite the existing schedule", async () => {
  const f = fixture(); await materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW);
  f.setContext({ ...context, checkOut: new Date("2026-09-29T15:00:00Z") });
  await assert.rejects(materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW), /CLEANING_WORK_SCHEDULE_CHANGED/);
  assert.equal(f.writes, 1);
  assert.equal(f.work?.scheduledStartAt.toISOString(), "2026-09-28T15:30:00.000Z");
});
test("another confirmation cannot take ownership of historical work", async () => {
  const f = fixture(); const r = await materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW);
  assert.ok(r.work); f.setWork({ ...r.work, confirmationId: "older-confirmation" });
  await assert.rejects(materializeCleaningWorkSnapshot(f.store, scope, TEST_NOW), /SNAPSHOT_BINDING_CONFLICT/);
  assert.equal(f.writes, 1);
});
test("malformed scope rejects before any database operation", async () => {
  const f = fixture();
  await assert.rejects(materializeCleaningWorkSnapshot(f.store, { ...scope, propertyId: "p'; drop table" }), /INVALID_SCOPE/);
  assert.equal(f.transactions, 0);
});
test("database failure is propagated, never converted to a successful snapshot", async () => {
  const error = new Error("DATABASE_UNAVAILABLE");
  const store: CleaningWorkSnapshotStore = { async transaction() { throw error; } };
  await assert.rejects(materializeCleaningWorkSnapshot(store, scope), e => e === error);
});

test("does not materialize new follow-up work retroactively from an old confirmed link", async () => {
  const f = fixture({
    checkOut: new Date("2026-09-27T15:00:00Z"),
    cleaningStartOffsetMinutes: 30,
  });
  await assert.rejects(
    () => materializeCleaningWorkSnapshot(f.store, scope, new Date("2026-09-28T15:00:00Z")),
    (error: unknown) =>
      error instanceof CleaningWorkSnapshotError &&
      error.code === "CLEANING_WORK_RETROACTIVE_ACTIVATION_BLOCKED",
  );
  assert.equal(f.writes, 0);
});

test("existing materialized work remains replayable after scheduled start", async () => {
  const f = fixture();
  const first = await materializeCleaningWorkSnapshot(
    f.store,
    scope,
    new Date("2026-09-28T15:00:00Z"),
  );
  assert.equal(first.outcome, "CREATED");
  const result = await materializeCleaningWorkSnapshot(
    f.store,
    scope,
    new Date("2026-09-28T16:00:00Z"),
  );
  assert.equal(result.outcome, "REPLAYED");
  assert.equal(result.work?.id, first.work?.id);
});
