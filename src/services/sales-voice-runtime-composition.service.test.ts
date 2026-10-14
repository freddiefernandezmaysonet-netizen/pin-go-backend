import assert from "node:assert/strict";
import {after,test} from "node:test";
import {EventEmitter} from "node:events";
import {createHmac} from "node:crypto";
import {createServer} from "node:http";
import express from "express";
import {PrismaClient} from "@prisma/client";
import {SimulatedSalesVoiceRuntime} from "./sales-voice-runtime-composition.service.js";
import {mountSalesVoiceLiveSipWebhook} from "./sales-voice-live-sip-mount.service.js";

const dbUrl=process.env.SALES_VOICE_ADMISSION_TEST_DATABASE_URL;
assert.ok(dbUrl);const url=new URL(dbUrl);
assert.equal(url.protocol,"postgresql:");assert.ok(["127.0.0.1","localhost"].includes(url.hostname));
assert.equal(url.pathname,"/pingo_sales_admission_test");assert.equal(process.env.DATABASE_URL,dbUrl);
const db=new PrismaClient({datasources:{db:{url:dbUrl}}});after(()=>db.$disconnect());
const id="live_runtime_fixture";
const secret="whsec_"+Buffer.from("commercial-runtime-signing-fixture-2026").toString("base64");
const env=()=>({
  NODE_ENV:"test",RAILWAY_ENVIRONMENT_NAME:"sales-voice-certification",
  SALES_VOICE_RUNTIME_SIMULATION_ENABLED:"true",SALES_VOICE_RUNTIME_RELEASE_CERTIFIED:"true",
  SALES_VOICE_SESSION_COORDINATOR_SIMULATION_ENABLED:"true",SALES_VOICE_SESSION_COORDINATOR_RELEASE_CERTIFIED:"true",
  SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED:"true",SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED:"true",
  SALES_VOICE_RECOVERY_SUPERVISOR_SIMULATION_ENABLED:"true",SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED:"true",
  SALES_VOICE_SAFETY_CONTROLLER_SIMULATION_ENABLED:"true",SALES_VOICE_SAFETY_CONTROLLER_RELEASE_CERTIFIED:"true",
  SALES_VOICE_SAFETY_LOOP_SIMULATION_ENABLED:"true",SALES_VOICE_SAFETY_LOOP_RELEASE_CERTIFIED:"true",
  SALES_VOICE_OBSERVER_HEARTBEAT_SIMULATION_ENABLED:"true",SALES_VOICE_OBSERVER_HEARTBEAT_RELEASE_CERTIFIED:"true",
  SALES_VOICE_LIVE_WEBHOOK_ENABLED:"true",SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED:"true",
  SALES_VOICE_OPENAI_WEBHOOK_SECRET:secret,SALES_VOICE_OPENAI_API_KEY:"sk-commercial-runtime-fixture",
});
const invite=()=>({sessionId:id,webhookEventId:"evt_runtime_fixture_123",fromPhoneHint:null,toPhoneHint:null});
class Socket extends EventEmitter{closed=false;close(){this.closed=true;}}
function fixture() {
  const tasks:Array<{task:()=>Promise<void>;delay:number;cancelled:boolean}>=[];
  const sockets:Socket[]=[];let accepts=0,hangups=0,stop:(()=>void)|undefined,removed=0,time=0;
  const options={
    db,env:env(),owner:"voice_runtime_fixture_owner",ttlSeconds:120,maxCallSeconds:60,
    maxSweepIntervalSeconds:10,pollMs:1000,
    limits:{enabled:true,maxConcurrentCalls:1,monthlyBudgetCents:1000,estimatedCentsPerMinute:10,reservedSecondsPerCall:120},
    accept:async()=>{accepts++;return{status:200};},
    hangup:async()=>{hangups++;return{status:200};},
    connect:()=>{const s=new Socket();sockets.push(s);return s;},
    schedule:(task:()=>Promise<void>,delay:number)=>{const e={task,delay,cancelled:false};tasks.push(e);return()=>{e.cancelled=true;};},
    monotonicNow:()=>time,
    subscribeShutdown:(handler:()=>void)=>{stop=handler;return()=>{removed++;};},
  };
  return{options,tasks,sockets,setTime:(value:number)=>{time=value;},
    signal:()=>stop?.(),counts:()=>({accepts,hangups,removed})};
}
async function clean(){await db.salesVoiceCall.deleteMany({});}
const row=()=>db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id}});
test("production, missing runtime flags, legacy claims and guest key cannot construct runtime",()=>{
  const f=fixture();
  assert.throws(()=>new SimulatedSalesVoiceRuntime({...f.options,env:{...env(),NODE_ENV:"production"}}),/PRODUCTION_VETO/);
  assert.throws(()=>new SimulatedSalesVoiceRuntime({...f.options,env:{...env(),SALES_VOICE_RUNTIME_RELEASE_CERTIFIED:"false"}}),/PRODUCTION_VETO/);
  assert.throws(()=>new SimulatedSalesVoiceRuntime({...f.options,env:{...env(),SALES_VOICE_ADMISSION_SIMULATION_ENABLED:"true"}}),/LEGACY_ADMISSION_CONFLICT/);
  const {SALES_VOICE_OPENAI_API_KEY:ignored,...missing}=env();
  assert.throws(()=>new SimulatedSalesVoiceRuntime({...f.options,env:{...missing,OPENAI_API_KEY:"sk-guest"}}),/COMMERCIAL_RUNTIME_KEY_REQUIRED/);
  assert.equal(f.tasks.length,0);
});
test("signed mount prohibits production runtime injection and simultaneous legacy admission",()=>{
  const f=fixture(),runtime=new SimulatedSalesVoiceRuntime(f.options),app=express();
  assert.throws(()=>mountSalesVoiceLiveSipWebhook(app,db,{...env(),NODE_ENV:"production"},runtime),/MOUNT_PRODUCTION_VETO/);
  assert.throws(()=>mountSalesVoiceLiveSipWebhook(app,db,{...env(),SALES_VOICE_ADMISSION_SIMULATION_ENABLED:"true"},runtime),/LEGACY_ADMISSION_CONFLICT/);
  runtime.stop();
});
test("constructed runtime starts no work; first healthy cycle is mandatory before acceptance",async()=>{
  await clean();const f=fixture(),r=new SimulatedSalesVoiceRuntime(f.options);
  assert.equal(f.tasks.length,0);assert.equal(r.ready(),false);
  assert.throws(()=>r.receiveVerified(invite()),/NOT_STARTED/);
  r.start();assert.throws(()=>r.start(),/ALREADY_STARTED/);
  await assert.rejects(r.receiveVerified(invite()),/SUPERVISION_NOT_READY/);
  assert.equal((await row()).status,"RECEIVED");assert.equal(f.counts().accepts,0);
  await f.tasks[0].task();assert.equal(r.ready(),true);
  assert.equal((await r.receiveVerified(invite())).state,"MONITORING");
  assert.equal(r.snapshot().observers,1);assert.equal(f.counts().accepts,1);
  r.stop();assert.equal((await row()).finalizedAt,null);
});
test("concurrent deliveries share one acceptance and repeated delivery cannot attach again",async()=>{
  await clean();const f=fixture(),r=new SimulatedSalesVoiceRuntime(f.options);
  r.start();await f.tasks[0].task();
  const all=await Promise.all(Array.from({length:8},()=>r.receiveVerified(invite())));
  assert.equal(all.filter(v=>v.state==="MONITORING").length,8);
  assert.equal(f.counts().accepts,1);assert.equal(f.sockets.length,1);
  assert.equal((await r.receiveVerified(invite())).state,"ALREADY_CLAIMED");
  assert.equal(f.counts().accepts,1);r.stop();
});
test("shutdown cancels observer and global timers without hangup or capacity release",async()=>{
  await clean();const f=fixture(),r=new SimulatedSalesVoiceRuntime(f.options);
  r.start();await f.tasks[0].task();await r.receiveVerified(invite());
  f.signal();f.signal();r.stop();
  for(const task of f.tasks)await task.task();
  assert.equal(f.sockets[0].closed,true);assert.equal(r.snapshot().observers,0);
  assert.equal(f.counts().hangups,0);assert.equal(f.counts().removed,1);
  assert.equal((await row()).status,"ACCEPTED");assert.equal((await row()).finalizedAt,null);
});
test("global deadline stops runtime and initial observer without inventing closure",async()=>{
  await clean();const f=fixture(),r=new SimulatedSalesVoiceRuntime(f.options);
  r.start();await f.tasks[0].task();await r.receiveVerified(invite());
  f.setTime(10000);await f.tasks[2].task();
  assert.equal(r.snapshot().stopped,true);assert.equal(f.sockets[0].closed,true);
  assert.equal((await row()).finalizedAt,null);assert.equal(f.counts().hangups,0);
});
test("authenticated session.closed removes initial observer and finalizes only bound usage",async()=>{
  await clean();const f=fixture(),r=new SimulatedSalesVoiceRuntime(f.options);
  r.start();await f.tasks[0].task();await r.receiveVerified(invite());
  f.sockets[0].emit("open");
  f.sockets[0].emit("message",JSON.stringify({type:"session.closed",event_id:"runtime_close",
    session:{id},reason:"remote_hangup",usage:{seconds:7}}));
  // Wait on bounded DB visibility, without issuing any provider operation.
  for(let i=0;i<30&&((await row()).finalizedAt===null||r.snapshot().observers!==0);i++)await new Promise(done=>setTimeout(done,5));
  assert.equal((await row()).status,"COMPLETED");assert.equal((await row()).finalUsageSeconds,7);
  assert.equal(r.snapshot().observers,0);assert.equal(f.counts().hangups,0);r.stop();
});
test("real local signed HTTP reaches composition once; forged signature cannot write",async()=>{
  await clean();const f=fixture(),r=new SimulatedSalesVoiceRuntime(f.options);
  r.start();await f.tasks[0].task();
  const app=express();mountSalesVoiceLiveSipWebhook(app,db,f.options.env,r);app.use(express.json());
  const server=createServer(app);await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const raw=JSON.stringify({id:"evt_runtime_http_12345",type:"live.transport.incoming",
    data:{type:"sip",session_id:id,sip_headers:[]}});
  const stamp=String(Math.floor(Date.now()/1000)),whid="wh_runtime_fixture";
  const signature=createHmac("sha256",Buffer.from(secret.slice(6),"base64"))
    .update(whid+"."+stamp+"."+raw).digest("base64");
  const post=(sig:string)=>fetch("http://127.0.0.1:"+address.port+"/webhooks/openai/sales-live-voice",{
    method:"POST",headers:{"content-type":"application/json","webhook-id":whid,
      "webhook-timestamp":stamp,"webhook-signature":"v1,"+sig},body:raw});
  try{
    assert.equal((await post("AAAA")).status,401);
    assert.equal(await db.salesVoiceCall.count({}),0);
    assert.equal((await post(signature)).status,202);
    assert.equal((await post(signature)).status,202);
    assert.equal(f.counts().accepts,1);assert.equal(f.sockets.length,1);
    assert.equal((await row()).status,"ACCEPTED");
  }finally{r.stop();await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));}
});

test("runtime release disablement stops scheduled work and initial observer",async()=>{
  await clean();const f=fixture(),r=new SimulatedSalesVoiceRuntime(f.options);
  r.start();await f.tasks[0].task();await r.receiveVerified(invite());
  f.options.env.SALES_VOICE_RUNTIME_RELEASE_CERTIFIED="false";
  await f.tasks[2].task();
  assert.equal(r.snapshot().stopped,true);assert.equal(f.sockets[0].closed,true);
  assert.equal(f.counts().hangups,0);assert.equal((await row()).finalizedAt,null);
});
