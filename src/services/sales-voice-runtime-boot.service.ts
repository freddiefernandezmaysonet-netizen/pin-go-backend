import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import type {ProviderHTTP} from "./sales-voice-live-admission.service.js";
import type {HangupHTTP} from "./sales-voice-live-watchdog.service.js";
import type {SidebandSocketFactory} from "./sales-voice-sideband-supervisor.service.js";
import {createOpenAISidebandWsFactory} from "./sales-voice-sideband-ws-transport.service.js";
import {SimulatedSalesVoiceRuntime} from "./sales-voice-runtime-composition.service.js";

type Env=Readonly<Record<string,string|undefined>>;
type DB=Pick<PrismaClient,"salesVoiceCall"|"$transaction"|"$queryRaw">;
export type SalesVoiceBootDependencies=Pick<
  ConstructorParameters<typeof SimulatedSalesVoiceRuntime>[0],
  "schedule"|"monotonicNow"|"subscribeShutdown"
>&{createTransports?:()=>{accept:ProviderHTTP;hangup:HangupHTTP;connect:SidebandSocketFactory}};
const gates=[
  "SALES_VOICE_RUNTIME_SIMULATION_ENABLED","SALES_VOICE_RUNTIME_RELEASE_CERTIFIED",
  "SALES_VOICE_SESSION_COORDINATOR_SIMULATION_ENABLED","SALES_VOICE_SESSION_COORDINATOR_RELEASE_CERTIFIED",
  "SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED","SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED",
  "SALES_VOICE_RECOVERY_SUPERVISOR_SIMULATION_ENABLED","SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED",
  "SALES_VOICE_SAFETY_CONTROLLER_SIMULATION_ENABLED","SALES_VOICE_SAFETY_CONTROLLER_RELEASE_CERTIFIED",
  "SALES_VOICE_SAFETY_LOOP_SIMULATION_ENABLED","SALES_VOICE_SAFETY_LOOP_RELEASE_CERTIFIED",
  "SALES_VOICE_OBSERVER_HEARTBEAT_SIMULATION_ENABLED","SALES_VOICE_OBSERVER_HEARTBEAT_RELEASE_CERTIFIED",
  "SALES_VOICE_LIVE_WEBHOOK_ENABLED","SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED",
] as const;
function integer(env:Env,name:string,min:number,max:number):number {
  const raw=env[name];
  if(typeof raw!=="string"||!/^[1-9]\d{0,8}$/.test(raw))throw new Error("INVALID_SALES_BOOT_LIMIT");
  const n=Number(raw);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error("INVALID_SALES_BOOT_LIMIT");
  return n;
}

/** Fixed-origin, redirect-free defaults. Creation opens no socket or SIP call. */
function providerTransports():ReturnType<NonNullable<SalesVoiceBootDependencies["createTransports"]>> {
  const valid=(url:string,action:"accept"|"hangup")=>{
    if(!new RegExp("^https://api\\.openai\\.com/v1/live/sessions/live_[A-Za-z0-9_-]{1,123}/"+action+"$").test(url))
      throw new Error("INVALID_SALES_BOOT_PROVIDER_ENDPOINT");
  };
  const accept:ProviderHTTP=async(url,request)=>{
    valid(url,"accept");
    const response=await fetch(url,{...request,redirect:"error"});
    return{status:response.status};
  };
  const hangup:HangupHTTP=async(url,request)=>{
    valid(url,"hangup");
    const response=await fetch(url,{...request,redirect:"error"});
    return{status:response.status};
  };
  return{accept,hangup,connect:createOpenAISidebandWsFactory()};
}

/** Called by the existing mount. Production stays metadata-only even if boot
 * flags are accidentally true. No DB, key or provider client is touched off.
 * No live release, new Railway service or environment mutation occurs here.
 */
export function bootSalesVoiceRuntime(db:DB,env:Env,
  dependencies:SalesVoiceBootDependencies={}):SimulatedSalesVoiceRuntime|undefined {
  if(env.SALES_VOICE_RUNTIME_BOOT_ENABLED!=="true"
    ||env.SALES_VOICE_RUNTIME_BOOT_RELEASE_CERTIFIED!=="true"
    ||env.NODE_ENV!=="test"||env.RAILWAY_ENVIRONMENT_NAME!=="sales-voice-certification")return;
  if(gates.some(name=>env[name]!=="true"))throw new Error("SALES_BOOT_RELEASE_GATES_REQUIRED");
  if(env.SALES_VOICE_ADMISSION_SIMULATION_ENABLED==="true"
    ||env.SALES_VOICE_ADMISSION_SIMULATION_RELEASE_CERTIFIED==="true")
    throw new Error("SALES_RUNTIME_LEGACY_ADMISSION_CONFLICT");
  const limits={
    enabled:true,
    maxConcurrentCalls:integer(env,"SALES_VOICE_MAX_CONCURRENT_CALLS",1,2),
    monthlyBudgetCents:integer(env,"SALES_VOICE_MONTHLY_BUDGET_CENTS",1,100000),
    estimatedCentsPerMinute:integer(env,"SALES_VOICE_ESTIMATED_CENTS_PER_MINUTE",1,1000),
    reservedSecondsPerCall:integer(env,"SALES_VOICE_RESERVED_SECONDS_PER_CALL",60,3600),
  };
  const ttlSeconds=integer(env,"SALES_VOICE_RECOVERY_LEASE_TTL_SECONDS",30,120);
  const maxCallSeconds=integer(env,"SALES_VOICE_MAX_CALL_SECONDS",60,3600);
  const maxSweepIntervalSeconds=integer(env,"SALES_VOICE_MAX_SWEEP_INTERVAL_SECONDS",2,60);
  const pollMs=integer(env,"SALES_VOICE_SAFETY_POLL_MS",1000,30000);
  if(limits.reservedSecondsPerCall<maxCallSeconds+maxSweepIntervalSeconds+5*limits.maxConcurrentCalls
    ||Math.ceil(limits.reservedSecondsPerCall/60)*limits.estimatedCentsPerMinute>limits.monthlyBudgetCents
    ||pollMs>maxSweepIntervalSeconds*500||maxSweepIntervalSeconds>Math.floor(ttlSeconds/3))
    throw new Error("SALES_BOOT_LIMITS_MISMATCH");
  if(!env.SALES_VOICE_OPENAI_API_KEY?.startsWith("sk-"))
    throw new Error("COMMERCIAL_RUNTIME_KEY_REQUIRED");
  const secret=env.SALES_VOICE_OPENAI_WEBHOOK_SECRET;
  if(!secret?.startsWith("whsec_"))throw new Error("COMMERCIAL_RUNTIME_SIGNATURE_REQUIRED");
  const encoded=secret.slice(6),decoded=Buffer.from(encoded,"base64");
  if(decoded.length<16||decoded.toString("base64")!==encoded)
    throw new Error("COMMERCIAL_RUNTIME_SIGNATURE_REQUIRED");
  const transports=(dependencies.createTransports??providerTransports)();
  const runtime=new SimulatedSalesVoiceRuntime({
    db,env,owner:"voice_"+randomUUID(),limits,ttlSeconds,maxCallSeconds,maxSweepIntervalSeconds,pollMs,
    ...transports,schedule:dependencies.schedule,monotonicNow:dependencies.monotonicNow,
    subscribeShutdown:dependencies.subscribeShutdown,
  });
  try{runtime.start();return runtime;}catch(error){runtime.stop();throw error;}
}
