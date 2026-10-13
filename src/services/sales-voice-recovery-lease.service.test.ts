import assert from "node:assert/strict";
import {after,test} from "node:test";
import {PrismaClient} from "@prisma/client";
import {SalesVoiceRecoveryLease,SalesRecoveryLeaseError} from "./sales-voice-recovery-lease.service.js";

const url=process.env.SALES_WATCHDOG_TEST_DATABASE_URL;
assert.ok(url,"Disposable database required");
const u=new URL(url);
assert.equal(u.protocol,"postgresql:");
assert.ok(["localhost","127.0.0.1"].includes(u.hostname));
assert.equal(u.pathname,"/pingo_sales_watchdog_test");
assert.equal(process.env.DATABASE_URL,url);
const db=new PrismaClient({datasources:{db:{url}}});
after(async()=>db.$disconnect());
const service=new SalesVoiceRecoveryLease(db);
const now=new Date("2026-10-13T22:00:00Z");
const owner1="voice_owner_0000000001",owner2="voice_owner_0000000002";
const id=(n:number)=>"live_lease_test_"+n;
async function reset(){await db.salesVoiceCall.deleteMany({where:{providerCallId:{startsWith:"live_lease_test_"}}});}
async function seed(n:number,status="ACCEPTED",options:{provider?:string;finalizedAt?:Date|null}={}){
  return db.salesVoiceCall.create({data:{
    providerCallId:id(n),provider:options.provider??"OPENAI_LIVE_SIP",
    direction:"INBOUND",status,finalizedAt:options.finalizedAt??null,
  }});
}
const request=(n:number,owner=owner1,time=now)=>({sessionId:id(n),owner,now:time,ttlSeconds:30});
test("one concurrent owner wins atomic claim, other owner cannot take or renew",async()=>{
  await reset();await seed(1);
  const [a,b]=await Promise.all([service.claim(request(1,owner1)),service.claim(request(1,owner2))]);
  assert.equal([a,b].filter(Boolean).length,1);
  const winning=a??b!;
  assert.equal(winning.epoch,1);
  const other=winning.owner===owner1?owner2:owner1;
  assert.equal(await service.claim(request(1,other)),null);
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(1)}});
  assert.equal(row.recoveryLeaseOwner,winning.owner);
  assert.equal(row.status,"ACCEPTED");
});
test("renew retains epoch, expiration fences stale owner, next owner increments epoch",async()=>{
  await reset();await seed(2);
  const a=(await service.claim(request(2)))!;
  const renewed=(await service.renew(a,new Date(now.getTime()+5000),30))!;
  assert.equal(renewed.epoch,a.epoch);
  assert.equal(await service.claim(request(2,owner2,new Date(now.getTime()+32000))),null);
  const b=(await service.claim(request(2,owner2,new Date(now.getTime()+36000))))!;
  assert.equal(b.epoch,2);
  assert.equal(await service.renew(a,new Date(now.getTime()+36000),30),null);
  assert.equal(await service.release(a,new Date(now.getTime()+36000)),false);
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(2)}})).recoveryLeaseOwner,owner2);
});
test("release clears only current lease; new claim uses higher epoch",async()=>{
  await reset();await seed(3);
  const a=(await service.claim(request(3)))!;
  assert.equal(await service.release(a,new Date(now.getTime()+1000)),true);
  assert.equal(await service.release(a,new Date(now.getTime()+1000)),false);
  const b=(await service.claim(request(3,owner2,new Date(now.getTime()+2000))))!;
  assert.equal(b.epoch,a.epoch+1);
});
test("no lease for unsigned metadata, closed calls or unrelated provider",async()=>{
  await reset();await seed(4,"RECEIVED");await seed(5,"COMPLETED");
  await seed(6,"ACCEPTED",{provider:"TWILIO"});
  await seed(7,"ACCEPTED",{finalizedAt:now});
  for(const n of [4,5,6,7])assert.equal(await service.claim(request(n)),null);
});
test("bad owner, ID, TTL or clock fail before database mutations",async()=>{
  await reset();await seed(8);
  for(const q of [
    {...request(8),owner:"bad"},
    {...request(8),sessionId:"invalid"},
    {...request(8),ttlSeconds:5},
    {...request(8),now:new Date("invalid")},
  ]){
    await assert.rejects(service.claim(q),e=>e instanceof SalesRecoveryLeaseError);
  }
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(8)}});
  assert.equal(row.recoveryLeaseEpoch,0);
  assert.equal(row.recoveryLeaseOwner,null);
});
test("finalization blocks renewal, but does not rewrite call outcome",async()=>{
  await reset();await seed(9);
  const a=(await service.claim(request(9)))!;
  await db.salesVoiceCall.update({where:{providerCallId:id(9)},data:{status:"COMPLETED",finalizedAt:now}});
  assert.equal(await service.renew(a,new Date(now.getTime()+1000),30),null);
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(9)}})).status,"COMPLETED");
});
