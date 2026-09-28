import assert from "node:assert/strict";
import test from "node:test";
import { runCleaningFollowupClaimCycle } from "./cleaning-followup-cycle.service.js";

const base:any={id:"w1",scheduledStartAt:new Date("2026-09-28T15:30:00Z"),durationCommitmentMinutes:120,startConfirmationGraceMinutes:30,followupGraceMinutes:15,timingConsentAcceptedAt:new Date("2026-09-28T14:00:00Z"),startConfirmedAt:null,completionConfirmedAt:null,cancelledAt:null,supersededAt:null};
test("claims start reminder when consented work crosses start grace",async()=>{
 const claims:any[]=[];const result=await runCleaningFollowupClaimCycle({repository:{findCandidates:async()=>[base]},receipts:{claim:async x=>{claims.push(x);return "CLAIMED";}},now:new Date("2026-09-28T16:00:00Z")});
 assert.equal(result[0]?.decision,"START_REMINDER_DUE");assert.equal(claims[0].kind,"START_REMINDER");
});
test("does not claim anything after completion",async()=>{
 let calls=0;const result=await runCleaningFollowupClaimCycle({repository:{findCandidates:async()=>[{...base,startConfirmedAt:new Date("2026-09-28T15:35:00Z"),completionConfirmedAt:new Date("2026-09-28T17:20:00Z")}]},receipts:{claim:async()=>{calls++;return "CLAIMED";}},now:new Date("2026-09-28T18:00:00Z")});
 assert.equal(result[0]?.decision,"COMPLETED");assert.equal(result[0]?.claim,"NOT_DUE");assert.equal(calls,0);
});
test("unconsented work is ignored",async()=>{
 let calls=0;const result=await runCleaningFollowupClaimCycle({repository:{findCandidates:async()=>[{...base,timingConsentAcceptedAt:null}]},receipts:{claim:async()=>{calls++;return "CLAIMED";}},now:new Date("2026-09-28T18:00:00Z")});
 assert.equal(result.length,0);assert.equal(calls,0);
});
