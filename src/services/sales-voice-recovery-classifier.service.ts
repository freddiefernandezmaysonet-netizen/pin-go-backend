import type { PrismaClient } from "@prisma/client";

/**
 * READ-ONLY recovery inventory for unresolved Live SIP calls after restarts.
 * This file cannot accept, hang up, attach, finalize, or bill a session.
 * It is not mounted in the server and is not imported by a worker.
 */
export type RecoveryState =
  | "VERIFY_ACCEPT"
  | "VERIFY_SESSION"
  | "VERIFY_HANGUP"
  | "WAIT_FOR_CONFIRMED_CLOSE"
  | "IGNORE_FINALIZED";

export function classifySalesVoiceRecovery(status: string, finalized: boolean): RecoveryState {
  if (finalized) return "IGNORE_FINALIZED";
  if (status === "ACCEPTED") return "VERIFY_SESSION";
  if (status === "HANGUP_SENT") return "WAIT_FOR_CONFIRMED_CLOSE";
  if (status === "HANGUP_CLAIMED" || status === "HANGUP_UNKNOWN") return "VERIFY_HANGUP";
  return "VERIFY_ACCEPT";
}

const unresolved = [
  "ADMISSION_CLAIMED", "ACCEPTED", "ACCEPT_UNKNOWN",
  "HANGUP_CLAIMED", "HANGUP_SENT", "HANGUP_UNKNOWN",
] as const;
type DB = Pick<PrismaClient, "salesVoiceCall">;
export type RecoveryCandidate = Readonly<{
  sessionId: string | null;
  state: RecoveryState | "QUARANTINE_INVALID_ID";
  status: string;
  staleSeconds: number;
}>;
export async function inventoryUnresolvedSalesVoiceCalls(input: {
  db: DB;
  now: Date;
  staleAfterSeconds: number;
  limit: number;
}): Promise<{candidates: RecoveryCandidate[]; hasMore: boolean}> {
  const {db,now,staleAfterSeconds,limit}=input;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())
    || !Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds<60 || staleAfterSeconds>86400
    || !Number.isSafeInteger(limit) || limit<1 || limit>100) {
    throw new Error("INVALID_RECOVERY_AUDIT_BOUNDS");
  }
  const rows=await db.salesVoiceCall.findMany({
    where:{
      provider:"OPENAI_LIVE_SIP",direction:"INBOUND",
      finalizedAt:null,status:{in:[...unresolved]},
      updatedAt:{lte:new Date(now.getTime()-staleAfterSeconds*1000)},
    },
    orderBy:[{updatedAt:"asc"},{id:"asc"}],
    take:limit+1,
    select:{providerCallId:true,status:true,updatedAt:true},
  });
  return {
    hasMore:rows.length>limit,
    candidates:rows.slice(0,limit).map(row=>{
      const valid=typeof row.providerCallId==="string"
        && /^live_[A-Za-z0-9_-]{1,123}$/.test(row.providerCallId);
      return {
        sessionId:valid?row.providerCallId:null,
        state:valid?classifySalesVoiceRecovery(row.status,false):"QUARANTINE_INVALID_ID",
        status:row.status,
        staleSeconds:Math.max(0,Math.floor((now.getTime()-row.updatedAt.getTime())/1000)),
      };
    }),
  };
}
