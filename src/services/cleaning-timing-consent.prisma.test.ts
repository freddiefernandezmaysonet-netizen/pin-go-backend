import assert from "node:assert/strict";
import test from "node:test";
import { acceptCleaningTimingConsent } from "./cleaning-timing-consent.prisma.js";
import { CLEANING_TIMING_CONSENT_VERSION } from "./cleaning-timing-consent.js";

function fakeDb(seed: any) {
  let row = { ...seed };
  const tx = {
    $queryRaw: async () => [{ id: seed.reservationId }],
    cleaningWork: {
      findFirst: async ({ where }: any) =>
        row.id === where.id && row.reservationId === where.reservationId &&
        row.staffMemberId === where.staffMemberId && row.confirmationId === where.confirmationId ? { ...row } : null,
      update: async ({ data }: any) => (row = { ...row, ...data }),
    },
  };
  return {
    db: { $transaction: async (run: any) => run(tx) } as any,
    read: () => row,
  };
}

const base = {
  id: "work_1", reservationId: "res_1", staffMemberId: "staff_1", confirmationId: "conf_1",
  cancelledAt: null, supersededAt: null, completionConfirmedAt: null,
  timingConsentVersion: null, timingConsentAcceptedAt: null,
};

test("persists explicit versioned consent once", async () => {
  const f = fakeDb(base);
  const at = new Date("2026-09-28T16:00:00.000Z");
  const result = await acceptCleaningTimingConsent(f.db, {
    workId: "work_1", reservationId: "res_1", staffMemberId: "staff_1", confirmationId: "conf_1",
  }, at);
  assert.equal(result.timingConsentVersion, CLEANING_TIMING_CONSENT_VERSION);
  assert.equal(result.timingConsentAcceptedAt, at);
});

test("replay preserves the original acceptance timestamp", async () => {
  const original = new Date("2026-09-28T16:00:00.000Z");
  const f = fakeDb({ ...base, timingConsentVersion: CLEANING_TIMING_CONSENT_VERSION, timingConsentAcceptedAt: original });
  const result = await acceptCleaningTimingConsent(f.db, {
    workId: "work_1", reservationId: "res_1", staffMemberId: "staff_1", confirmationId: "conf_1",
  }, new Date("2026-09-28T17:00:00.000Z"));
  assert.equal(result.timingConsentAcceptedAt, original);
});

test("closed work cannot accept timing consent", async () => {
  const f = fakeDb({ ...base, cancelledAt: new Date("2026-09-28T15:00:00.000Z") });
  await assert.rejects(() => acceptCleaningTimingConsent(f.db, {
    workId: "work_1", reservationId: "res_1", staffMemberId: "staff_1", confirmationId: "conf_1",
  }), /CLEANING_TIMING_CONSENT_WORK_CLOSED/);
});
