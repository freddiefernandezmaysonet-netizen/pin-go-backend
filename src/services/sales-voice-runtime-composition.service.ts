import {salesVoiceCertificationEnvironmentAllowed, salesVoiceCertificationLimitsMatch} from "./sales-voice-certification-profile.service.js";
import type { PrismaClient } from "@prisma/client";
import type { AdmissionLimits, ProviderHTTP } from "./sales-voice-live-admission.service.js";
import type { HangupHTTP } from "./sales-voice-live-watchdog.service.js";
import type { SidebandSocketFactory } from "./sales-voice-sideband-supervisor.service.js";
import { recordVerifiedLiveSipInvite, type VerifiedLiveSipInvitation } from "./sales-voice-live-sip-auth.service.js";
import { SimulatedSalesVoiceSafetyController } from "./sales-voice-safety-controller.service.js";
import {
  coordinateSimulatedLiveSipSession, startSimulatedSalesVoiceObserverHeartbeat,
  type ObserverHeartbeatTimer,
} from "./sales-voice-live-session-coordinator.service.js";

type Env = Readonly<Record<string,string|undefined>>;
type DB = Pick<PrismaClient,"salesVoiceCall"|"$transaction"|"$queryRaw">;
const allowed = (env: Env) => salesVoiceCertificationEnvironmentAllowed(env)
  && env.SALES_VOICE_RUNTIME_SIMULATION_ENABLED === "true"
  && env.SALES_VOICE_RUNTIME_RELEASE_CERTIFIED === "true";
type State = "MONITORING" | "ALREADY_CLAIMED" | "ACCEPT_UNKNOWN" | "RECOVERY_OWNERSHIP_UNAVAILABLE" | "SIDE_BAND_CONNECT_FAILED" | "STOPPED";

/** Explicit composition for certification inside the existing signed mount.
 * No default provider transport, server import, service creation or live enablement.
 * SIGTERM/SIGINT close local observers only. Persisted call capacity is retained.
 */
export class SimulatedSalesVoiceRuntime {
  private readonly safety: SimulatedSalesVoiceSafetyController;
  private readonly key: string;
  private started = false;
  private stopped = false;
  private unsubscribe?: () => void;
  private loop?: ReturnType<SimulatedSalesVoiceSafetyController["startLoop"]>;
  private readonly schedule: ObserverHeartbeatTimer;
  private readonly observers = new Map<string,{stop:()=>void}>();
  private readonly pending = new Map<string,{invite:VerifiedLiveSipInvitation;work:Promise<{state:State}>}>();

  constructor(private readonly input: {
    db:DB;env:Env;owner:string;limits:AdmissionLimits;ttlSeconds:number;
    maxCallSeconds:number;maxSweepIntervalSeconds:number;pollMs:number;
    accept:ProviderHTTP;hangup:HangupHTTP;connect:SidebandSocketFactory;
    schedule?:ObserverHeartbeatTimer;monotonicNow?:()=>number;
    subscribeShutdown?:(stop:()=>void)=>()=>void;
  }) {
    if(!allowed(input.env))throw new Error("SALES_RUNTIME_PRODUCTION_VETO");
    if(!salesVoiceCertificationLimitsMatch(input.env,input.limits))
      throw new Error("PRIVATE_CERTIFICATION_POLICY_REQUIRED");
    if(input.env.SALES_VOICE_ADMISSION_SIMULATION_ENABLED==="true"
      ||input.env.SALES_VOICE_ADMISSION_SIMULATION_RELEASE_CERTIFIED==="true")
      throw new Error("SALES_RUNTIME_LEGACY_ADMISSION_CONFLICT");
    if(!Number.isSafeInteger(input.limits.maxConcurrentCalls)
      ||input.limits.maxConcurrentCalls<1||input.limits.maxConcurrentCalls>2
      ||typeof input.accept!=="function"||typeof input.hangup!=="function"
      ||typeof input.connect!=="function")throw new Error("INVALID_RUNTIME_DEPENDENCIES");
    const key=input.env.SALES_VOICE_OPENAI_API_KEY;
    if(!key?.startsWith("sk-"))throw new Error("COMMERCIAL_RUNTIME_KEY_REQUIRED");
    this.key=key;
    const schedule=input.schedule??((task:()=>Promise<void>,delay:number)=>{
      const timer=setTimeout(()=>{void task();},delay);timer.unref();return()=>clearTimeout(timer);
    });
    this.schedule=(task,delay)=>schedule(async()=>{
      if(this.stopped||!allowed(this.input.env)){this.stop();return;}
      try{await task();}finally{
        if(!allowed(this.input.env)||(this.loop&&this.loop.snapshot().phase!=="RUNNING"))this.stop();
      }
    },delay);
    this.input={...input,limits:{...input.limits,
      certificationWindow:input.limits.certificationWindow?{...input.limits.certificationWindow}:undefined}};
    this.safety=new SimulatedSalesVoiceSafetyController({
      db:input.db,env:input.env,owner:input.owner,ttlSeconds:input.ttlSeconds,
      staleAfterSeconds:60,maxOwned:input.limits.maxConcurrentCalls,
      maxCallSeconds:input.maxCallSeconds,maxSweepIntervalSeconds:input.maxSweepIntervalSeconds,
      admissionLimits:this.input.limits,
      connect:(url,options)=>{this.assertActive();return this.input.connect(url,options);},
      hangup:async(url,request)=>{this.assertActive();return this.input.hangup(url,request);},
    });
  }
  private assertActive() {
    if(this.stopped||!allowed(this.input.env))throw new Error("SALES_RUNTIME_DISABLED");
  }
  start():void {
    this.assertActive();
    if(this.started)throw new Error("SALES_RUNTIME_ALREADY_STARTED");
    this.started=true;
    try {
      this.loop=this.safety.startLoop({pollMs:this.input.pollMs,schedule:this.schedule,
        monotonicNow:this.input.monotonicNow});
      if(this.loop.snapshot().phase!=="RUNNING")throw new Error("SALES_RUNTIME_LOOP_FAILED");
      const subscribe=this.input.subscribeShutdown??((stop:()=>void)=>{
        process.once("SIGTERM",stop);process.once("SIGINT",stop);
        return()=>{process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);};
      });
      this.unsubscribe=subscribe(()=>this.stop());
      if(typeof this.unsubscribe!=="function")throw new Error("INVALID_RUNTIME_SHUTDOWN");
    }catch{this.stop();throw new Error("SALES_RUNTIME_START_FAILED");}
  }
  ready():boolean {
    return this.started&&!this.stopped&&allowed(this.input.env)
      &&salesVoiceCertificationLimitsMatch(this.input.env,this.input.limits)
      &&this.safety.permitsAdmission(this.input.limits);
  }
  snapshot(){return{started:this.started,stopped:this.stopped,
    pending:this.pending.size,observers:this.observers.size,ready:this.ready()};}
  stop():void {
    if(this.stopped)return;
    this.stopped=true;
    this.safety.stop();
    for(const observer of this.observers.values())observer.stop();
    this.observers.clear();
    try{this.unsubscribe?.();}catch{/* local cleanup cannot release call capacity */}
    this.unsubscribe=undefined;
  }
  receiveVerified(invite:VerifiedLiveSipInvitation):Promise<{state:State}> {
    this.assertActive();
    if(!this.started)throw new Error("SALES_RUNTIME_NOT_STARTED");
    const existing=this.pending.get(invite.sessionId);
    if(existing){
      if(existing.invite.fromPhoneHint!==invite.fromPhoneHint
        ||existing.invite.toPhoneHint!==invite.toPhoneHint)throw new Error("SESSION_ID_COLLISION");
      return existing.work;
    }
    if(this.pending.size>=this.input.limits.maxConcurrentCalls)
      throw new Error("SALES_RUNTIME_PENDING_LIMIT");
    const saved={...invite};
    const work=this.runVerified(saved).finally(()=>{this.pending.delete(saved.sessionId);});
    this.pending.set(saved.sessionId,{invite:saved,work});
    return work;
  }
  private async runVerified(invite:VerifiedLiveSipInvitation):Promise<{state:State}> {
    await recordVerifiedLiveSipInvite(this.input.db,invite);
    this.assertActive();
    if(!this.ready())throw new Error("SALES_RUNTIME_SUPERVISION_NOT_READY");
    const result=await coordinateSimulatedLiveSipSession({
      db:this.input.db,env:this.input.env,sessionId:invite.sessionId,apiKey:this.key,
      limits:this.input.limits,observerOwner:this.input.owner,observerTtlSeconds:this.input.ttlSeconds,
      supervision:{permitsAdmission:limits=>this.ready()&&this.safety.permitsAdmission(limits)},
      acceptTransport:async(url,request)=>{this.assertActive();return this.input.accept(url,request);},
      hangupTransport:async(url,request)=>{this.assertActive();return this.input.hangup(url,request);},
      sidebandConnect:(url,options)=>{this.assertActive();return this.input.connect(url,options);},
    });
    if(result.state==="MONITORING"){
      if(this.stopped||!allowed(this.input.env)){result.disconnect();return{state:"STOPPED"};}
      let heartbeat:ReturnType<typeof startSimulatedSalesVoiceObserverHeartbeat>;
      try {
        heartbeat=startSimulatedSalesVoiceObserverHeartbeat({
          session:result,env:this.input.env,pollMs:this.input.pollMs,
          schedule:this.schedule,monotonicNow:this.input.monotonicNow,
        });
      }catch{result.disconnect();this.stop();throw new Error("SALES_RUNTIME_HEARTBEAT_FAILED");}
      const observer={stop:()=>heartbeat.stop()};
      this.observers.set(invite.sessionId,observer);
      const cleanup=()=>{
        observer.stop();
        if(this.observers.get(invite.sessionId)===observer)this.observers.delete(invite.sessionId);
      };
      void result.completion.then(cleanup,cleanup);
    }
    return{state:result.state};
  }
}
