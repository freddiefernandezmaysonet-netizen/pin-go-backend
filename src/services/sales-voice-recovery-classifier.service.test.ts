import assert from "node:assert/strict";
import {after,test} from "node:test";
import {PrismaClient} from "@prisma/client";
import {classifySalesVoiceRecovery,inventoryUnresolvedSalesVoiceCalls} from "./sales-voice-recovery-classifier.service.js";

const url=process.env.SALES_WATCHDOG_TEST_DATABASE_URL;
assert.ok(url,"Disposable recovery database required");
const target=new URL(url);
assert.equal(target.protocol,"postgresql:");
assert.ok(["localhost","127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname,"/pingo_sales_watchdog_test");
assert.equal(process.env.DATABASE_URL,url);
const db=new PrismaClient({datasources:{db:{url}}});
after(async()=>db.$disconnect());
const now=new Date("2026-10-13T20:00:00.000Z");
const old=new Date(now.getTime()-600_000);
const recent=new Date(now.getTime()-10_000);
async function reset(){
  await db.salesVoiceCall.deleteMany({where:{providerCallId:{startsWith:"live_recovery_test_"}}});
}
async function make(n:number,status:string,opts:{provider?:string;direction?:string;finalizedAt?:Date|null;updatedAt?:Date}={}){
  return db.salesVoiceCall.create({data:{
    providerCallId:"live_recovery_test_"+n,
    provider:opts.provider??"OPENAI_LIVE_SIP",
    direction:opts.direction??"INBOUND",
    status,updatedAt:opts.updatedAt??old,
    finalizedAt:opts.finalizedAt??null,
  }});
}
test("pure state mapping never confuses disconnect or hangup acknowledgment with closure",()=>{
  assert.equal(classifySalesVoiceRecovery("ACCEPT_UNKNOWN",false),"VERIFY_ACCEPT");
  assert.equal(classifySalesVoiceRecovery("ADMISSION_CLAIMED",false),"VERIFY_ACCEPT");
  assert.equal(classifySalesVoiceRecovery("ACCEPTED",false),"VERIFY_SESSION");
  assert.equal(classifySalesVoiceRecovery("HANGUP_UNKNOWN",false),"VERIFY_HANGUP");
  assert.equal(classifySalesVoiceRecovery("HANGUP_CLAIMED",false),"VERIFY_HANGUP");
  assert.equal(classifySalesVoiceRecovery("HANGUP_SENT",false),"WAIT_FOR_CONFIRMED_CLOSE");
  assert.equal(classifySalesVoiceRecovery("HANGUP_SENT",true),"IGNORE_FINALIZED");
});
test("inventory selects stale unfinalized inbound OpenAI calls only and never modifies them",async()=>{
  await reset();
  await make(1,"ACCEPTED");
  await make(2,"HANGUP_SENT",{updatedAt:new Date(old.getTime()+1000)});
  await make(3,"ACCEPT_UNKNOWN",{updatedAt:recent});
  await make(4,"COMPLETED");
  await make(5,"ACCEPTED",{provider:"TWILIO"});
  await make(6,"ACCEPTED",{direction:"OUTBOUND"});
  await make(7,"ACCEPTED",{finalizedAt:old});
  const before=await db.salesVoiceCall.findMany({where:{providerCallId:{startsWith:"live_recovery_test_"}}});
  const result=await inventoryUnresolvedSalesVoiceCalls({db,now,staleAfterSeconds:60,limit:10});
  assert.deepEqual(result.candidates.map(x=>[x.sessionId,x.state]),[
    ["live_recovery_test_1","VERIFY_SESSION"],
    ["live_recovery_test_2","WAIT_FOR_CONFIRMED_CLOSE"],
  ]);
  assert.equal(result.hasMore,false);
  assert.equal(result.candidates[0].staleSeconds,600);
  const afterRows=await db.salesVoiceCall.findMany({where:{providerCallId:{startsWith:"live_recovery_test_"}}});
  assert.deepEqual(afterRows,before);
});
test("bounded scan is deterministic and reports more without taking ownership",async()=>{
  await reset();
  await make(11,"ADMISSION_CLAIMED");
  await make(12,"ACCEPT_UNKNOWN",{updatedAt:new Date(old.getTime()+1000)});
  await make(13,"HANGUP_UNKNOWN",{updatedAt:new Date(old.getTime()+2000)});
  const result=await inventoryUnresolvedSalesVoiceCalls({db,now,staleAfterSeconds:60,limit:2});
  assert.equal(result.candidates.length,2);
  assert.equal(result.hasMore,true);
  assert.equal(result.candidates[0].state,"VERIFY_ACCEPT");
});
test("invalid scan bounds are rejected without DB operations",async()=>{
  for(const x of [{limit:0,staleAfterSeconds:60},{limit:101,staleAfterSeconds:60},{limit:1,staleAfterSeconds:1}]){
    await assert.rejects(inventoryUnresolvedSalesVoiceCalls({db,now,...x}),/INVALID_RECOVERY_AUDIT_BOUNDS/);
  }
});
