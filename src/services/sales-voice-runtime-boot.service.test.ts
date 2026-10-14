import assert from "node:assert/strict";
import {test} from "node:test";
import express from "express";
import type {PrismaClient} from "@prisma/client";
import {bootSalesVoiceRuntime,type SalesVoiceBootDependencies} from "./sales-voice-runtime-boot.service.js";
import {mountSalesVoiceLiveSipWebhook} from "./sales-voice-live-sip-mount.service.js";
const env=()=>({
  NODE_ENV:"test",RAILWAY_ENVIRONMENT_NAME:"sales-voice-certification",
  SALES_VOICE_RUNTIME_BOOT_ENABLED:"true",SALES_VOICE_RUNTIME_BOOT_RELEASE_CERTIFIED:"true",
  SALES_VOICE_RUNTIME_SIMULATION_ENABLED:"true",SALES_VOICE_RUNTIME_RELEASE_CERTIFIED:"true",
  SALES_VOICE_SESSION_COORDINATOR_SIMULATION_ENABLED:"true",SALES_VOICE_SESSION_COORDINATOR_RELEASE_CERTIFIED:"true",
  SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED:"true",SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED:"true",
  SALES_VOICE_RECOVERY_SUPERVISOR_SIMULATION_ENABLED:"true",SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED:"true",
  SALES_VOICE_SAFETY_CONTROLLER_SIMULATION_ENABLED:"true",SALES_VOICE_SAFETY_CONTROLLER_RELEASE_CERTIFIED:"true",
  SALES_VOICE_SAFETY_LOOP_SIMULATION_ENABLED:"true",SALES_VOICE_SAFETY_LOOP_RELEASE_CERTIFIED:"true",
  SALES_VOICE_OBSERVER_HEARTBEAT_SIMULATION_ENABLED:"true",SALES_VOICE_OBSERVER_HEARTBEAT_RELEASE_CERTIFIED:"true",
  SALES_VOICE_LIVE_WEBHOOK_ENABLED:"true",SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED:"true",
  SALES_VOICE_MAX_CONCURRENT_CALLS:"1",SALES_VOICE_MONTHLY_BUDGET_CENTS:"1000",
  SALES_VOICE_ESTIMATED_CENTS_PER_MINUTE:"10",SALES_VOICE_RESERVED_SECONDS_PER_CALL:"120",
  SALES_VOICE_RECOVERY_LEASE_TTL_SECONDS:"120",SALES_VOICE_MAX_CALL_SECONDS:"60",
  SALES_VOICE_MAX_SWEEP_INTERVAL_SECONDS:"10",SALES_VOICE_SAFETY_POLL_MS:"1000",
  SALES_VOICE_OPENAI_API_KEY:"sk-commercial-boot-fixture",
  SALES_VOICE_OPENAI_WEBHOOK_SECRET:"whsec_"+Buffer.from("boot-commercial-signature-fixture").toString("base64"),
});
const db=new Proxy({} as PrismaClient,{get(){throw Error("DATABASE_TOUCHED");}});
function dependencies(){
  let clients=0,registered=0,removed=0,stop!:()=>void;
  const timers:Array<{cancelled:boolean;task:()=>Promise<void>}>=[];
  const deps:SalesVoiceBootDependencies={
    createTransports:()=>{clients++;return{
      accept:async()=>{throw Error("PROVIDER_TOUCHED");},
      hangup:async()=>{throw Error("PROVIDER_TOUCHED");},
      connect:()=>{throw Error("PROVIDER_TOUCHED");},
    };},
    schedule:task=>{const t={cancelled:false,task};timers.push(t);return()=>{t.cancelled=true;};},
    monotonicNow:()=>0,
    subscribeShutdown:handler=>{registered++;stop=handler;return()=>{removed++;};},
  };
  return{deps,timers,halt:()=>stop(),counts:()=>({clients,registered,removed})};
}
test("off and production boot touch no DB, commercial credential or provider factory",()=>{
  const d=dependencies();
  for(const config of [{},{...env(),NODE_ENV:"production"},{...env(),RAILWAY_ENVIRONMENT_NAME:"production"},
    {...env(),SALES_VOICE_RUNTIME_BOOT_ENABLED:"false"},{...env(),SALES_VOICE_RUNTIME_BOOT_RELEASE_CERTIFIED:"false"}]){
    const guarded=new Proxy(config,{get(target,key){
      if(key==="SALES_VOICE_OPENAI_API_KEY"||key==="OPENAI_API_KEY")throw Error("CREDENTIAL_TOUCHED");
      return Reflect.get(target,key);
    }});
    assert.equal(bootSalesVoiceRuntime(db,guarded,d.deps),undefined);
  }
  assert.deepEqual(d.counts(),{clients:0,registered:0,removed:0});
});
test("every execution release gate is required before creating provider clients",()=>{
  const d=dependencies(),base=env();
  const keys=Object.keys(base).filter(k=>k.endsWith("_ENABLED")||k.endsWith("_CERTIFIED"))
    .filter(k=>!k.startsWith("SALES_VOICE_RUNTIME_BOOT_"));
  for(const key of keys)assert.throws(
    ()=>bootSalesVoiceRuntime(db,{...base,[key]:"false"},d.deps),/RELEASE_GATES_REQUIRED/);
  assert.equal(d.counts().clients,0);
});
test("legacy admission claims cannot coexist with boot-owned one-shot acceptance",()=>{
  const d=dependencies();
  assert.throws(()=>bootSalesVoiceRuntime(db,{...env(),SALES_VOICE_ADMISSION_SIMULATION_ENABLED:"true"},d.deps),/LEGACY_ADMISSION_CONFLICT/);
  assert.equal(d.counts().clients,0);
});
test("invalid numeric and reservation settings fail before creating any provider client",()=>{
  const d=dependencies();
  for(const config of [
    {...env(),SALES_VOICE_MAX_CONCURRENT_CALLS:"3"},
    {...env(),SALES_VOICE_MONTHLY_BUDGET_CENTS:"1.5"},
    {...env(),SALES_VOICE_RESERVED_SECONDS_PER_CALL:"60"},
    {...env(),SALES_VOICE_MONTHLY_BUDGET_CENTS:"1"},
    {...env(),SALES_VOICE_SAFETY_POLL_MS:"6000"},
    {...env(),SALES_VOICE_MAX_SWEEP_INTERVAL_SECONDS:"50"},
    {...env(),SALES_VOICE_RECOVERY_LEASE_TTL_SECONDS:"10"},
  ])assert.throws(()=>bootSalesVoiceRuntime(db,config,d.deps),/BOOT_LIMIT/);
  assert.equal(d.counts().clients,0);
});
test("guest API key and API key used as signing secret cannot authorize boot",()=>{
  const d=dependencies();
  const {SALES_VOICE_OPENAI_API_KEY:ignored,...missing}=env();
  assert.throws(()=>bootSalesVoiceRuntime(db,{...missing,OPENAI_API_KEY:"sk-guest"},d.deps),/COMMERCIAL_RUNTIME_KEY_REQUIRED/);
  for(const secret of ["sk-commercial-boot-fixture","whsec_invalid"])assert.throws(
    ()=>bootSalesVoiceRuntime(db,{...env(),SALES_VOICE_OPENAI_WEBHOOK_SECRET:secret},d.deps),/SIGNATURE_REQUIRED/);
  assert.equal(d.counts().clients,0);
});
test("valid boot creates clients only once and owns cancellable shutdown",()=>{
  const d=dependencies(),runtime=bootSalesVoiceRuntime(db,env(),d.deps)!;
  assert.equal(runtime.ready(),false);assert.equal(d.timers.length,1);
  assert.deepEqual(d.counts(),{clients:1,registered:1,removed:0});
  d.halt();runtime.stop();
  assert.equal(d.timers[0].cancelled,true);
  assert.deepEqual(d.counts(),{clients:1,registered:1,removed:1});
});
test("existing mount boots the runtime without explicit runtime injection",()=>{
  const d=dependencies();
  mountSalesVoiceLiveSipWebhook(express(),db,env(),undefined,d.deps);
  assert.deepEqual(d.counts(),{clients:1,registered:1,removed:0});
  d.halt();assert.equal(d.timers[0].cancelled,true);
});
test("mount registration failure cancels only the runtime created by that mount",()=>{
  const d=dependencies();
  assert.throws(()=>mountSalesVoiceLiveSipWebhook(
    {use:()=>{throw Error("fixture mount failure");}} as Pick<ReturnType<typeof express>,"use">,
    db,env(),undefined,d.deps),/fixture mount failure/);
  assert.equal(d.timers[0].cancelled,true);assert.equal(d.counts().removed,1);
});
