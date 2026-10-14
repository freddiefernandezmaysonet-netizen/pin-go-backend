import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  coordinateSimulatedLiveSipSession, SalesVoiceCoordinationError,
  type CoordinatorResult,
} from "./sales-voice-live-session-coordinator.service.js";
import type { AdmissionLimits, ProviderHTTP } from "./sales-voice-live-admission.service.js";
import type { HangupHTTP } from "./sales-voice-live-watchdog.service.js";
import type { SidebandSocketFactory } from "./sales-voice-sideband-supervisor.service.js";

const dbUrl = process.env.SALES_VOICE_ADMISSION_TEST_DATABASE_URL;
assert.ok(dbUrl, "Dedicated disposable Postgres database required");
const url = new URL(dbUrl);
assert.equal(url.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.equal(url.pathname, "/pingo_sales_admission_test");
assert.equal(dbUrl, process.env.DATABASE_URL);
const db = new PrismaClient({datasources:{db:{url:dbUrl}}});
after(async()=>db.$disconnect());

const environment = {
  NODE_ENV: "test", RAILWAY_ENVIRONMENT_NAME:"sales-voice-certification",
  SALES_VOICE_SESSION_COORDINATOR_SIMULATION_ENABLED:"true",
  SALES_VOICE_SESSION_COORDINATOR_RELEASE_CERTIFIED:"true",
};
const limits:AdmissionLimits={
  enabled:true,maxConcurrentCalls:1,monthlyBudgetCents:500,
  estimatedCentsPerMinute:10,reservedSecondsPerCall:120,
};
const sessionId=(n:number)=>"live_coordinator_fixture_"+n;
const key="sk-fixture-coordinator-only";
let seq=100;
const next=()=>sessionId(seq++);
async function clean() {
  await db.salesVoiceCall.deleteMany({where:{provider:"OPENAI_LIVE_SIP"}});
}
async function seeded(id:string){
  return db.salesVoiceCall.create({data:{
    provider:"OPENAI_LIVE_SIP",providerCallId:id,
    direction:"INBOUND",status:"RECEIVED",
  }});
}
async function state(id:string){
  return db.salesVoiceCall.findUnique({where:{providerCallId:id}});
}
class Socket extends EventEmitter {
  closed=false;
  close() {this.closed=true;}
  opened(){this.emit("open");}
  lost(){this.emit("close");}
  usage(seconds:number){this.emit("message",Buffer.from(JSON.stringify({
    type:"session.usage.updated",event_id:"ev_usage_"+seconds,
    usage:{seconds},
  })));}
  closeConfirmed(id:string,seconds:number){this.emit("message",Buffer.from(JSON.stringify({
    type:"session.closed",event_id:"ev_final_100",
    session:{id},reason:"remote_hangup",usage:{seconds},
  })));}
}
function deps(id:string, opts: {
  env?:Record<string,string|undefined>;
  acceptStatus?:number;
  acceptThrows?:boolean;
  hangupStatus?:number;
  hangupThrows?:boolean;
  attachThrows?:boolean;
  useLimits?:AdmissionLimits;
  useDb?:PrismaClient;
}={}){
  const socket=new Socket();
  let accepts=0,hangups=0,attaches=0;
  const acceptTransport:ProviderHTTP=async (uri, request)=>{
    accepts++;
    assert.equal(uri,"https://api.openai.com/v1/live/sessions/"+id+"/accept");
    assert.equal(request.method,"POST");
    assert.equal(request.headers.Authorization,"Bearer "+key);
    const config=JSON.parse(request.body);
    assert.equal(config.session.model,"gpt-live-1");
    assert.equal(config.session.type,"live");
    assert.equal("format" in config.session.audio,false);
    if(opts.acceptThrows)throw Error("simulated provider network timeout");
    return {status:opts.acceptStatus??200};
  };
  const hangupTransport:HangupHTTP=async(uri,request)=>{
    hangups++;
    assert.equal(uri,"https://api.openai.com/v1/live/sessions/"+id+"/hangup");
    assert.equal(request.method,"POST");
    if(opts.hangupThrows)throw Error("simulated ambiguous hangup");
    return {status:opts.hangupStatus??200};
  };
  const connect:SidebandSocketFactory=(uri,options)=>{
    attaches++;
    assert.equal(uri,"wss://api.openai.com/v1/live/sessions/"+id+"/attach");
    assert.equal(options.headers.Authorization,"Bearer "+key);
    if(opts.attachThrows)throw Error("simulated failed authenticated websocket handshake");
    return socket;
  };
  return {
    socket,
    get counts(){return {accepts,hangups,attaches};},
    run:()=>coordinateSimulatedLiveSipSession({
      db:opts.useDb??db,env:opts.env??environment,sessionId:id,apiKey:key,
      limits:opts.useLimits??limits,acceptTransport,
      observerOwner:"voice_initial_observer_fixture",observerTtlSeconds:120,
      hangupTransport,sidebandConnect:connect,
    }),
  };
}
function monitoring(result:CoordinatorResult):asserts result is Extract<CoordinatorResult,{state:"MONITORING"}>{
  assert.equal(result.state,"MONITORING");
}
const err=(code:string)=>(x:unknown)=>x instanceof SalesVoiceCoordinationError&&x.code===code;

test("production is absolutely vetoed before any provider or database claim",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id,{env:{...environment,NODE_ENV:"production"}});
  await assert.rejects(d.run(),err("PRODUCTION_AND_RELEASE_VETO"));
  assert.deepEqual(d.counts,{accepts:0,hangups:0,attaches:0});
  assert.equal((await state(id))?.status,"RECEIVED");
});
test("missing either opt-in flag or wrong isolated environment cannot run provider actions",async()=>{
  await clean();const id=next();await seeded(id);
  for(const env of [
    {...environment,SALES_VOICE_SESSION_COORDINATOR_SIMULATION_ENABLED:"false"},
    {...environment,SALES_VOICE_SESSION_COORDINATOR_RELEASE_CERTIFIED:"false"},
    {...environment,RAILWAY_ENVIRONMENT_NAME:"production"},
  ]){
    const d=deps(id,{env});
    await assert.rejects(d.run(),err("PRODUCTION_AND_RELEASE_VETO"));
    assert.equal(d.counts.accepts,0);
  }
  assert.equal((await state(id))?.status,"RECEIVED");
});
test("successful accept attaches to exact sideband; only session.closed finalizes",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);
  const result=await d.run();
  monitoring(result);
  assert.deepEqual(d.counts,{accepts:1,hangups:0,attaches:1});
  assert.equal((await state(id))?.status,"ACCEPTED");
  assert.equal((await state(id))?.recoveryLeaseOwner,"voice_initial_observer_fixture");
  assert.equal((await state(id))?.recoveryLeaseEpoch,1);
  d.socket.opened();
  d.socket.usage(10);
  d.socket.closeConfirmed(id,12);
  assert.equal(await result.completion,"CONFIRMED_CLOSED");
  const saved=await state(id);
  assert.equal(saved?.status,"COMPLETED");
  assert.equal(saved?.finalUsageSeconds,12);
  assert.ok(saved?.finalizedAt);
  assert.equal(d.counts.hangups,0);
});
test("eight concurrent tries accept only once and never attach twice",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);
  const all=await Promise.all(Array.from({length:8},()=>d.run()));
  assert.equal(all.filter(x=>x.state==="MONITORING").length,1);
  assert.equal(all.filter(x=>x.state==="ALREADY_CLAIMED").length,7);
  assert.deepEqual(d.counts,{accepts:1,hangups:0,attaches:1});
  d.socket.opened();d.socket.closeConfirmed(id,4);
  assert.equal(await all.find(x=>x.state==="MONITORING")!.completion,"CONFIRMED_CLOSED");
});
test("ambiguous HTTP timeout is recorded UNKNOWN, never blindly retried",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id,{acceptThrows:true});
  assert.equal((await d.run()).state,"ACCEPT_UNKNOWN");
  assert.equal((await d.run()).state,"ALREADY_CLAIMED");
  assert.deepEqual(d.counts,{accepts:1,hangups:0,attaches:0});
  assert.equal((await state(id))?.status,"ACCEPT_UNKNOWN");
});
test("provider non-200 is held for reconciliation rather than fabricated success",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id,{acceptStatus:503});
  assert.equal((await d.run()).state,"ACCEPT_UNKNOWN");
  assert.equal((await state(id))?.status,"ACCEPT_UNKNOWN");
  assert.deepEqual(d.counts,{accepts:1,hangups:0,attaches:0});
});
test("sideband attach failure makes one fenced hangup, without false closure",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id,{attachThrows:true});
  const r=await d.run();
  assert.equal(r.state,"SIDE_BAND_CONNECT_FAILED");
  assert.equal(await r.completion,"HANGUP_SENT_AWAITING_CLOSE");
  assert.deepEqual(d.counts,{accepts:1,hangups:1,attaches:1});
  assert.equal((await state(id))?.status,"HANGUP_SENT");
  assert.equal((await state(id))?.finalizedAt,null);
  assert.equal((await d.run()).state,"ALREADY_CLAIMED");
  assert.equal(d.counts.hangups,1);
});
test("lost sideband triggers one hangup but cannot release the slot",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);
  const r=await d.run();
  monitoring(r);
  d.socket.opened();d.socket.lost();
  assert.equal(await r.completion,"HANGUP_SENT_AWAITING_CLOSE");
  assert.equal((await state(id))?.status,"HANGUP_SENT");
  assert.equal((await state(id))?.finalizedAt,null);
  assert.equal(d.counts.hangups,1);
});
test("ambiguous hangup is preserved as UNKNOWN with no retry",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id,{hangupThrows:true});
  const r=await d.run();
  monitoring(r);
  d.socket.opened();d.socket.lost();
  assert.equal(await r.completion,"HANGUP_UNKNOWN_AWAITING_RECONCILIATION");
  assert.equal((await state(id))?.status,"HANGUP_UNKNOWN");
  assert.equal(d.counts.hangups,1);
  assert.equal(await d.run().then(x=>x.state),"ALREADY_CLAIMED");
  assert.equal(d.counts.hangups,1);
});
test("budget and concurrency deny before provider calls",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id,{useLimits:{...limits,monthlyBudgetCents:1}});
  await assert.rejects(d.run(),/ESTIMATED_MONTHLY_BUDGET_LIMIT/);
  assert.equal((await state(id))?.status,"RECEIVED");
  assert.deepEqual(d.counts,{accepts:0,hangups:0,attaches:0});
});

test("replacement owner fences initial observer: no usage, closure or hangup",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  d.socket.opened();
  await db.salesVoiceCall.update({where:{providerCallId:id},data:{
    recoveryLeaseOwner:"voice_replacement_fixture",recoveryLeaseEpoch:{increment:1},
  }});
  d.socket.closeConfirmed(id,9);
  assert.equal(await r.completion,"OWNERSHIP_LOST");
  const saved=await state(id);
  assert.equal(saved?.status,"ACCEPTED");assert.equal(saved?.finalizedAt,null);
  assert.equal(saved?.finalUsageSeconds,null);assert.equal(d.counts.hangups,0);
  assert.equal(d.socket.closed,true);
});
test("expired initial ownership cannot finalize or trigger callback hangup",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  d.socket.opened();
  await db.salesVoiceCall.update({where:{providerCallId:id},data:{
    recoveryLeaseUntil:new Date("2000-01-01T00:00:00Z"),
  }});
  d.socket.usage(8);
  assert.equal(await r.completion,"OWNERSHIP_LOST");
  const saved=await state(id);
  assert.equal(saved?.lastUsageSeconds,null);assert.equal(saved?.finalizedAt,null);
  assert.equal(d.counts.hangups,0);
});
test("exhausted persisted observer budget holds accepted call without attach or hangup",async()=>{
  await clean();const id=next();await seeded(id);
  await db.salesVoiceCall.update({where:{providerCallId:id},data:{recoveryLeaseEpoch:3}});
  const d=deps(id);
  assert.equal((await d.run()).state,"RECOVERY_OWNERSHIP_UNAVAILABLE");
  assert.deepEqual(d.counts,{accepts:1,hangups:0,attaches:0});
  assert.equal((await state(id))?.status,"ACCEPTED");
  assert.equal((await state(id))?.finalizedAt,null);
});

test("explicit heartbeat extends persisted ownership without another epoch or attach",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  d.socket.opened();
  await db.salesVoiceCall.update({where:{providerCallId:id},data:{
    recoveryLeaseUntil:new Date(Date.now()+30000),
  }});
  const before=(await state(id))!.recoveryLeaseUntil!;
  assert.equal(await r.renewOwnership(),true);
  const saved=await state(id);
  assert.ok(saved!.recoveryLeaseUntil!.getTime()>before.getTime());
  assert.equal(saved?.recoveryLeaseEpoch,1);
  assert.equal(saved?.recoveryLeaseOwner,"voice_initial_observer_fixture");
  assert.deepEqual(d.counts,{accepts:1,hangups:0,attaches:1});
  d.socket.closeConfirmed(id,5);
  assert.equal(await r.completion,"CONFIRMED_CLOSED");
  assert.equal(await r.renewOwnership(),false);
});
test("concurrent explicit heartbeats share one pending renewal",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  const a=r.renewOwnership(),b=r.renewOwnership();
  assert.equal(a,b);assert.equal(await a,true);
  assert.equal((await state(id))?.recoveryLeaseEpoch,1);
  r.disconnect();assert.equal(await r.completion,"OBSERVER_STOPPED");
  assert.equal(d.counts.hangups,0);
});
test("local shutdown is idempotent and preserves capacity without provider hangup",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  r.disconnect();r.disconnect();
  assert.equal(await r.completion,"OBSERVER_STOPPED");
  assert.equal(await r.renewOwnership(),false);
  assert.equal(d.socket.closed,true);
  const saved=await state(id);
  assert.equal(saved?.status,"ACCEPTED");assert.equal(saved?.finalizedAt,null);
  assert.equal(saved?.recoveryLeaseEpoch,1);assert.equal(d.counts.hangups,0);
});
test("heartbeat cannot renew a replacement owner's lease and closes only local socket",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  await db.salesVoiceCall.update({where:{providerCallId:id},data:{
    recoveryLeaseOwner:"voice_replacement_fixture",recoveryLeaseEpoch:{increment:1},
  }});
  assert.equal(await r.renewOwnership(),false);
  assert.equal(await r.completion,"OWNERSHIP_LOST");
  assert.equal((await state(id))?.recoveryLeaseOwner,"voice_replacement_fixture");
  assert.equal((await state(id))?.status,"ACCEPTED");
  assert.equal(d.socket.closed,true);assert.equal(d.counts.hangups,0);
});
test("expired heartbeat cannot reacquire ownership or release the call",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  await db.salesVoiceCall.update({where:{providerCallId:id},data:{
    recoveryLeaseUntil:new Date("2000-01-01T00:00:00Z"),
  }});
  assert.equal(await r.renewOwnership(),false);
  assert.equal(await r.completion,"OWNERSHIP_LOST");
  assert.equal((await state(id))?.recoveryLeaseEpoch,1);
  assert.equal((await state(id))?.finalizedAt,null);assert.equal(d.counts.hangups,0);
});
test("disabled release gate stops heartbeat and callback provider effects",async()=>{
  await clean();const id=next();await seeded(id);
  const env={...environment};const d=deps(id,{env});
  const r=await d.run();monitoring(r);
  env.SALES_VOICE_SESSION_COORDINATOR_RELEASE_CERTIFIED="false";
  assert.equal(await r.renewOwnership(),false);
  assert.equal(await r.completion,"OBSERVER_STOPPED");
  assert.equal(d.counts.hangups,0);assert.equal((await state(id))?.status,"ACCEPTED");
});
test("database renewal failure stops local observer without releasing capacity",async()=>{
  await clean();const id=next();await seeded(id);
  let fault=false;
  const faulty=new Proxy(db,{get(target,prop){
    if(prop==="$transaction"&&fault)return()=>Promise.reject(Error("fixture DB outage"));
    const value=Reflect.get(target,prop,target);
    return typeof value==="function"?value.bind(target):value;
  }});
  const d=deps(id,{useDb:faulty});const r=await d.run();monitoring(r);
  fault=true;assert.equal(await r.renewOwnership(),false);
  assert.equal(await r.completion,"OWNERSHIP_LOST");
  assert.equal(d.socket.closed,true);assert.equal(d.counts.hangups,0);
  assert.equal((await state(id))?.status,"ACCEPTED");
});
test("provider socket loss after takeover cannot claim or send a callback hangup",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  await db.salesVoiceCall.update({where:{providerCallId:id},data:{
    recoveryLeaseOwner:"voice_replacement_fixture",recoveryLeaseEpoch:{increment:1},
  }});
  d.socket.lost();
  assert.equal(await r.completion,"OWNERSHIP_LOST");
  assert.equal((await state(id))?.hangupClaimedAt,null);
  assert.equal((await state(id))?.status,"ACCEPTED");assert.equal(d.counts.hangups,0);
});
test("shutdown during pending heartbeat never revives the stopped observer",async()=>{
  await clean();const id=next();await seeded(id);
  const d=deps(id);const r=await d.run();monitoring(r);
  const pending=r.renewOwnership();r.disconnect();
  assert.equal(await pending,false);assert.equal(await r.completion,"OBSERVER_STOPPED");
  assert.equal(await r.renewOwnership(),false);
  assert.equal(d.counts.hangups,0);assert.equal((await state(id))?.finalizedAt,null);
});
