import assert from "node:assert/strict";
import test from "node:test";
import { claimCleaningFollowupDue, followupDueForDecision } from "./cleaning-followup-receipt.service.js";

const dates={startReminderAt:new Date("2026-09-28T16:00:00Z"),scheduledCompletionAt:new Date("2026-09-28T17:30:00Z"),hostAttentionAt:new Date("2026-09-28T17:45:00Z")};
test("maps start reminder to its stable due key",()=>assert.deepEqual(followupDueForDecision({decision:"START_REMINDER_DUE",...dates}),{kind:"START_REMINDER",dueAt:dates.startReminderAt}));
test("maps completion reminder to committed completion",()=>assert.deepEqual(followupDueForDecision({decision:"COMPLETION_REMINDER_DUE",...dates}),{kind:"COMPLETION_REMINDER",dueAt:dates.scheduledCompletionAt}));
test("completed work produces no receipt",()=>assert.equal(followupDueForDecision({decision:"COMPLETED",...dates}),null));
test("claim delegates once to idempotent store",async()=>{
 let calls=0;const store={claim:async()=>{calls++;return "CLAIMED" as const;}};
 assert.equal(await claimCleaningFollowupDue(store,"work_1",{kind:"START_REMINDER",dueAt:dates.startReminderAt}),"CLAIMED");assert.equal(calls,1);
});
