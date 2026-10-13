import type { PrismaClient } from "@prisma/client";

/**
 * Durable, fenced recovery ownership only. Does NOT accept/reject/hang up
 * sessions, attach WebSockets, finalize usage or run in a worker.
 *
 * The lease owner must stop ALL side effects when renew() returns false.
 * This module is unmounted until a separately certified runtime exists.
 */
type DB = Pick<PrismaClient, "salesVoiceCall">;
const held = [
  "ADMISSION_CLAIMED", "ACCEPTED", "ACCEPT_UNKNOWN",
  "HANGUP_CLAIMED", "HANGUP_SENT", "HANGUP_UNKNOWN",
] as const;
export type RecoveryLease = Readonly<{
  sessionId: string;
  owner: string;
  epoch: number;
  expiresAt: Date;
}>;
export class SalesRecoveryLeaseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesRecoveryLeaseError";
  }
}
const deny = (code:string):never => { throw new SalesRecoveryLeaseError(code); };
function validate(sessionId:string,owner:string,now:Date):void {
  if(typeof sessionId!=="string" || !/^live_[A-Za-z0-9_-]{1,123}$/.test(sessionId))
    deny("INVALID_SESSION_ID");
  if(typeof owner!=="string" || !/^voice_[A-Za-z0-9_-]{12,70}$/.test(owner))
    deny("INVALID_LEASE_OWNER");
  if(!(now instanceof Date) || !Number.isFinite(now.getTime()))
    deny("INVALID_TIME");
}
function ttl(value:number):number {
  if(!Number.isSafeInteger(value) || value<10 || value>120)
    return deny("INVALID_LEASE_TTL");
  return value;
}
function epoch(value:number):number {
  if(!Number.isSafeInteger(value) || value<1)
    return deny("INVALID_LEASE_EPOCH");
  return value;
}
export class SalesVoiceRecoveryLease {
  constructor(private readonly db:DB) {}
  async claim(input:{
    sessionId:string;owner:string;now:Date;ttlSeconds:number;
  }):Promise<RecoveryLease|null> {
    const {sessionId,owner,now}=input;
    validate(sessionId,owner,now);
    const seconds=ttl(input.ttlSeconds);
    const expiresAt=new Date(now.getTime()+seconds*1000);
    const changed=await this.db.salesVoiceCall.updateMany({
      where:{
        providerCallId:sessionId,provider:"OPENAI_LIVE_SIP",
        direction:"INBOUND",status:{in:[...held]},finalizedAt:null,
        OR:[{recoveryLeaseUntil:null},{recoveryLeaseUntil:{lte:now}}],
      },
      data:{
        recoveryLeaseOwner:owner,recoveryLeaseUntil:expiresAt,
        recoveryLeaseEpoch:{increment:1},
      },
    });
    if(changed.count!==1)return null;
    const row=await this.db.salesVoiceCall.findUniqueOrThrow({
      where:{providerCallId:sessionId},
      select:{recoveryLeaseOwner:true,recoveryLeaseUntil:true,recoveryLeaseEpoch:true},
    });
    if(row.recoveryLeaseOwner!==owner
      || row.recoveryLeaseUntil?.getTime()!==expiresAt.getTime()) {
      deny("LEASE_LOST_DURING_CLAIM");
    }
    return {sessionId,owner,epoch:epoch(row.recoveryLeaseEpoch),expiresAt};
  }
  async renew(lease:RecoveryLease,now:Date,ttlSeconds:number):Promise<RecoveryLease|null> {
    validate(lease.sessionId,lease.owner,now);
    epoch(lease.epoch);
    const expiresAt=new Date(now.getTime()+ttl(ttlSeconds)*1000);
    const changed=await this.db.salesVoiceCall.updateMany({
      where:{
        providerCallId:lease.sessionId,provider:"OPENAI_LIVE_SIP",
        direction:"INBOUND",status:{in:[...held]},finalizedAt:null,
        recoveryLeaseOwner:lease.owner,recoveryLeaseEpoch:lease.epoch,
        recoveryLeaseUntil:{gt:now},
      },
      data:{recoveryLeaseUntil:expiresAt},
    });
    return changed.count===1?{...lease,expiresAt}:null;
  }
  async release(lease:RecoveryLease,now:Date):Promise<boolean> {
    validate(lease.sessionId,lease.owner,now);
    epoch(lease.epoch);
    const changed=await this.db.salesVoiceCall.updateMany({
      where:{
        providerCallId:lease.sessionId,provider:"OPENAI_LIVE_SIP",
        recoveryLeaseOwner:lease.owner,recoveryLeaseEpoch:lease.epoch,
        recoveryLeaseUntil:{gt:now},
      },
      data:{recoveryLeaseOwner:null,recoveryLeaseUntil:null},
    });
    return changed.count===1;
  }
}
