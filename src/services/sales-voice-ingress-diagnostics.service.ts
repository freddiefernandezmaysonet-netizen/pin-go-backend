type Snapshot={started:boolean;stopped:boolean;pending:number;observers:number;ready:boolean};
const safeCodes=new Set([
  "SALES_RUNTIME_DISABLED","SALES_RUNTIME_NOT_STARTED","SALES_RUNTIME_PENDING_LIMIT",
  "SALES_RUNTIME_SUPERVISION_NOT_READY","SALES_RUNTIME_HEARTBEAT_FAILED",
  "SESSION_ID_COLLISION","CONCURRENCY_LIMIT","ESTIMATED_MONTHLY_BUDGET_LIMIT",
  "CERTIFICATION_ATTEMPT_LIMIT","CERTIFICATION_WINDOW_CLOSED","CERTIFICATION_FRESH_INVITE_REQUIRED",
  "CERTIFICATION_DATABASE_CLOCK_REQUIRED","VERIFIED_LIVE_CALL_REQUIRED","NOT_ADMISSIBLE_STATUS",
  "INVALID_SESSION_ID","PRIVATE_CERTIFICATION_POLICY_REQUIRED",
  "P1001","P1002","P1008","P2024","P2034",
]);
/** Allowlisted internal diagnostics only. Never serialize an exception, invitation or provider payload. */
export async function diagnoseSalesVoiceIngress<T>(work:()=>Promise<T>,
  snapshot:(()=>Snapshot)|undefined,
  report:(entry:Record<string,string|number|boolean>)=>void=entry=>console.warn("[sales-voice] ingress failed",entry),
):Promise<T>{
  try{return await work();}catch(error){
    let code="UNCLASSIFIED";
    try{
      const e=error as {code?:unknown;message?:unknown};
      const candidate=typeof e?.code==="string"?e.code:e?.message;
      if(typeof candidate==="string"&&safeCodes.has(candidate))code=candidate;
    }catch{/* Untrusted error properties are not diagnostics. */}
    const entry:Record<string,string|number|boolean>={code};
    try{
      const state=snapshot?.();
      if(state){
        for(const key of ["started","stopped","ready"] as const)
          if(typeof state[key]==="boolean")entry[key]=state[key];
        for(const key of ["pending","observers"] as const)
          if(Number.isSafeInteger(state[key])&&state[key]>=0)entry[key]=state[key];
      }
    }catch{/* Diagnostics cannot replace the original failure. */}
    try{report(entry);}catch{/* Logging must not change webhook behavior. */}
    throw error;
  }
}
