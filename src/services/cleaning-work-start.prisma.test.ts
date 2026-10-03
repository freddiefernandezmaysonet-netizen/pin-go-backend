import assert from "node:assert/strict";
import test from "node:test";
import { confirmCleaningStart } from "./cleaning-work-start.prisma.js";

function fakeDb(seed: any) {
  let row = { ...seed };
  const tx = { $queryRaw: async () => [{ id: seed.reservationId }], cleaningWork: {
    findFirst: async ({ where }: any) => row.id === where.id && row.reservationId === where.reservationId &&
      row.staffMemberId === where.staffMemberId && row.confirmationId === where.confirmationId ? { ...row } : null,
    update: async ({ data }: any) => (row = { ...row, ...data }),
  }};
  return { db: { $transaction: async (run: any) => run(tx) } as any, read: () => row };
}
const base = {
  id:"work_1", reservationId:"res_1", staffMemberId:"staff_1", confirmationId:"conf_1",
  timingConsentVersion:"cleaning_timing_v1", timingConsentAcceptedAt:new Date("2026-09-28T14:00:00Z"),
  startConfirmedAt:null, completionConfirmedAt:null, cancelledAt:null, supersededAt:null,
  scheduledStartAt:new Date("2026-09-28T15:30:00Z"), durationCommitmentMinutes:120,
};

test("records cleaner start declaration after timing consent", async () => {
  const f=fakeDb(base); const at=new Date("2026-09-28T15:36:00Z");
  const result=await confirmCleaningStart(f.db,{workId:"work_1",reservationId:"res_1",staffMemberId:"staff_1",confirmationId:"conf_1"},at);
  assert.equal(result.startConfirmedAt,at);
  assert.equal(result.scheduledStartAt.toISOString(),"2026-09-28T15:30:00.000Z");
  assert.equal(result.durationCommitmentMinutes,120);
});
test("replay preserves first start confirmation time", async () => {
  const original=new Date("2026-09-28T15:36:00Z"); const f=fakeDb({...base,startConfirmedAt:original});
  const result=await confirmCleaningStart(f.db,{workId:"work_1",reservationId:"res_1",staffMemberId:"staff_1",confirmationId:"conf_1"},new Date("2026-09-28T16:00:00Z"));
  assert.equal(result.startConfirmedAt,original);
});
test("cannot confirm start before timing consent", async () => {
  const f=fakeDb({...base,timingConsentVersion:null,timingConsentAcceptedAt:null});
  await assert.rejects(()=>confirmCleaningStart(f.db,{workId:"work_1",reservationId:"res_1",staffMemberId:"staff_1",confirmationId:"conf_1"}),/CLEANING_START_TIMING_CONSENT_REQUIRED/);
});
test("closed work cannot confirm start", async () => {
  const f=fakeDb({...base,cancelledAt:new Date("2026-09-28T15:00:00Z")});
  await assert.rejects(()=>confirmCleaningStart(f.db,{workId:"work_1",reservationId:"res_1",staffMemberId:"staff_1",confirmationId:"conf_1"}),/CLEANING_START_WORK_CLOSED/);
});
