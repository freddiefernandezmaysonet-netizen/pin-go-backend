import assert from "node:assert/strict";import test from "node:test";
import { reconcileCleaningFollowupDeliveryEvidence } from "./cleaning-followup-delivery-reconciliation.service.js";
test("promotes FAILED receipt only from correlated legacy SENT evidence",async()=>{let update:any=null;const prisma:any={
 cleaningFollowupReceipt:{findMany:async()=>[{id:"r1",cleaningWorkId:"w1",kind:"START_REMINDER",claimedAt:new Date("2026-09-28T15:00:00Z")}],updateMany:async(x:any)=>{update=x;return{count:1}}},
 cleaningWork:{findUnique:async()=>({reservationId:"res1",staffMemberId:"s1"})},
 staffMember:{findUnique:async()=>({phoneE164:"+17875550100"})},
 messageLog:{findFirst:async({where}:any)=>{assert.equal(where.communicationType,"CLEANING_FOLLOWUP_START_REMINDER");assert.equal(where.status,"SENT");assert.equal(where.reservationId,"res1");return{providerMessageId:"SM1",updatedAt:new Date("2026-09-28T15:02:00Z")};}}
};const out=await reconcileCleaningFollowupDeliveryEvidence(prisma);assert.equal(out.reconciled,1);assert.equal(update.data.deliveryStatus,"SENT");assert.equal(update.data.providerMessageId,"SM1");});
test("does not promote without SENT evidence",async()=>{let writes=0;const prisma:any={cleaningFollowupReceipt:{findMany:async()=>[{id:"r1",cleaningWorkId:"w1",kind:"COMPLETION_REMINDER",claimedAt:new Date()}],updateMany:async()=>{writes++;}},cleaningWork:{findUnique:async()=>({reservationId:"res1",staffMemberId:"s1"})},staffMember:{findUnique:async()=>({phoneE164:"+17875550100"})},messageLog:{findFirst:async()=>null}};const out=await reconcileCleaningFollowupDeliveryEvidence(prisma);assert.equal(out.reconciled,0);assert.equal(writes,0);});
