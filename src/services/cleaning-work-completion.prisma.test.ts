import assert from "node:assert/strict";
import test from "node:test";
import { confirmCleaningCompletion } from "./cleaning-work-completion.prisma.js";

import { cleaningActionFixture as fakeDb } from "./cleaning-action-window.fixture.js";

const base={
  id:"work_1",reservationId:"res_1",staffMemberId:"staff_1",confirmationId:"conf_1",
  timingConsentVersion:"cleaning_timing_v1",timingConsentAcceptedAt:new Date("2026-09-28T14:00:00Z"),
  startConfirmedAt:new Date("2026-09-28T15:35:00Z"),completionConfirmedAt:null,cancelledAt:null,supersededAt:null,
};
const input={workId:"work_1",reservationId:"res_1",staffMemberId:"staff_1",confirmationId:"conf_1"};

test("records first cleaner completion declaration",async()=>{
  const f=fakeDb(base);const at=new Date("2026-09-28T17:20:00Z");
  assert.equal((await confirmCleaningCompletion(f.db,input,at)).completionConfirmedAt,at);
});
test("replay preserves original completion declaration",async()=>{
  const original=new Date("2026-09-28T17:20:00Z");const f=fakeDb({...base,completionConfirmedAt:original});
  assert.equal((await confirmCleaningCompletion(f.db,input,new Date("2026-09-28T18:00:00Z"))).completionConfirmedAt,original);
});
test("completion requires explicit start declaration",async()=>{
  const f=fakeDb({...base,startConfirmedAt:null});
  await assert.rejects(()=>confirmCleaningCompletion(f.db,input),/CLEANING_COMPLETION_START_REQUIRED/);
});
test("cancelled work cannot be completed",async()=>{
  const f=fakeDb({...base,cancelledAt:new Date("2026-09-28T16:00:00Z")});
  await assert.rejects(()=>confirmCleaningCompletion(f.db,input),/CLEANING_COMPLETION_WORK_CLOSED/);
});
