import type {AdmissionLimits} from "./sales-voice-live-admission.service.js";
// Bounds for private phone certification; ordinary production stays disabled.
export const SALES_VOICE_CERTIFICATION_MAX_CALL_SECONDS=300;
export const SALES_VOICE_CERTIFICATION_MAX_RESERVED_SECONDS=360;
type Env=Readonly<Record<string,string|undefined>>;

export const isSalesVoiceSimulationEnvironment=(env:Env):boolean=>
  env.NODE_ENV==="test"&&env.RAILWAY_ENVIRONMENT_NAME==="sales-voice-certification";

/** Dedicated commercial opt-in; never impersonate the test environment or
 * alter the shared process environment. Expiry denies admission separately:
 * ongoing recovery, duration control and authenticated close remain active.
 */
export const privateSalesVoiceCertificationRequested=(env:Env):boolean=>
  env.NODE_ENV==="production"&&env.RAILWAY_ENVIRONMENT_NAME==="production"
  &&env.SALES_VOICE_PRIVATE_CERTIFICATION_ENABLED==="true"
  &&env.SALES_VOICE_PRIVATE_CERTIFICATION_RELEASE_CERTIFIED==="true";

export function privateSalesVoiceCertificationWindow(env:Env):AdmissionLimits["certificationWindow"] {
  if(!privateSalesVoiceCertificationRequested(env))return;
  const start=env.SALES_VOICE_CERTIFICATION_STARTS_AT_MS,end=env.SALES_VOICE_CERTIFICATION_ENDS_AT_MS;
  if(typeof start!=="string"||typeof end!=="string"||!/^\d{13}$/.test(start)||!/^\d{13}$/.test(end))
    throw new Error("INVALID_PRIVATE_CERTIFICATION_WINDOW");
  const startsAtMs=Number(start),endsAtMs=Number(end);
  if(startsAtMs<=0||endsAtMs<=startsAtMs||endsAtMs-startsAtMs>15*60*1000)
    throw new Error("INVALID_PRIVATE_CERTIFICATION_WINDOW");
  return{startsAtMs,endsAtMs};
}

export function salesVoiceCertificationEnvironmentAllowed(env:Env):boolean {
  if(isSalesVoiceSimulationEnvironment(env))return true;
  if(env.SALES_VOICE_RUNTIME_BOOT_ENABLED!=="true"
    ||env.SALES_VOICE_RUNTIME_BOOT_RELEASE_CERTIFIED!=="true")return false;
  try{return privateSalesVoiceCertificationWindow(env)!==undefined;}catch{return false;}
}

/** Production admission must carry the exact bounded profile, including its
 * window. Low-level composition/coordinator injection cannot omit the quota.
 */
export function salesVoiceCertificationLimitsMatch(env:Env,limits:AdmissionLimits):boolean {
  if(isSalesVoiceSimulationEnvironment(env))return true;
  if(!salesVoiceCertificationEnvironmentAllowed(env))return false;
  try{
    const window=privateSalesVoiceCertificationWindow(env)!;
    return limits.enabled&&limits.maxConcurrentCalls===1
      &&Number.isSafeInteger(limits.reservedSecondsPerCall)
      &&limits.reservedSecondsPerCall>=60&&limits.reservedSecondsPerCall<=SALES_VOICE_CERTIFICATION_MAX_RESERVED_SECONDS
      &&Number.isSafeInteger(limits.monthlyBudgetCents)
      &&limits.monthlyBudgetCents>=1&&limits.monthlyBudgetCents<=1000
      &&limits.certificationWindow?.startsAtMs===window.startsAtMs
      &&limits.certificationWindow?.endsAtMs===window.endsAtMs;
  }catch{return false;}
}
