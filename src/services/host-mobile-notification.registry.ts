import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { HostAttentionKind } from './host-mobile-notification.policy.js';
const PROJECT = 'f7037a5c-4526-46d7-b7bb-fb56e2be2f8f';
const kinds: HostAttentionKind[] = ['GUEST_INCIDENT','GUEST_MESSAGE','CLEANING_EXCEPTION','ACCESS_EXCEPTION'];
export class HostPushRegistryError extends Error { constructor(readonly status:number,readonly code:string){super(code);} }
const fail=(status:number,code:string):never=>{throw new HostPushRegistryError(status,code);};
export type PushActor={id:string;orgId:string;sessionId:string};
type Env=Readonly<Record<string,string|undefined>>;
function object(value:unknown,allowed:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))return fail(400,'PUSH_REQUEST_INVALID');
  return value as Record<string,unknown>;
}
export function parsePushRegistration(value:unknown){
  const v=object(value,['token','platform','projectId']);
  if(typeof v.token!=='string'||! /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{16,200}\]$/.test(v.token)||!['ios','android'].includes(String(v.platform))||v.projectId!==PROJECT)return fail(400,'PUSH_REQUEST_INVALID');
  return {token:v.token,platform:v.platform as string,projectId:PROJECT};
}
export function parsePushPreference(value:unknown){
  const v=object(value,['enabled','kinds','timezone','quietHours','expectedRevision']);
  if(typeof v.enabled!=='boolean'||!Array.isArray(v.kinds)||v.kinds.some(k=>!kinds.includes(k))||new Set(v.kinds).size!==v.kinds.length||typeof v.timezone!=='string'||v.timezone.length>100||!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<0)return fail(400,'PUSH_REQUEST_INVALID');
  try{new Intl.DateTimeFormat('en-US',{timeZone:v.timezone}).format();}catch{return fail(400,'PUSH_REQUEST_INVALID');}
  let quietStartHour:number|null=null,quietEndHour:number|null=null,allowCritical=false;
  if(v.quietHours!==null){const q=object(v.quietHours,['startHour','endHour','allowCritical']);
    if(![q.startHour,q.endHour].every(h=>Number.isInteger(h)&&Number(h)>=0&&Number(h)<=23)||q.startHour===q.endHour||typeof q.allowCritical!=='boolean')return fail(400,'PUSH_REQUEST_INVALID');
    quietStartHour=q.startHour as number;quietEndHour=q.endHour as number;allowCritical=q.allowCritical;
  }
  return {enabled:v.enabled,kinds:v.kinds as string[],timezone:v.timezone,quietStartHour,quietEndHour,allowCritical,expectedRevision:v.expectedRevision as number};
}
function sealToken(env:Env,aad:string,token:string){
  const keyId=env.HOST_MOBILE_PUSH_TOKEN_KEY_ID??'';let key:Buffer;
  try{const ring=JSON.parse(env.HOST_MOBILE_PUSH_TOKEN_KEYS??'{}');if(!/^[A-Za-z0-9_-]{1,40}$/.test(keyId)||typeof ring[keyId]!=='string'||!/^[a-f0-9]{64}$/i.test(ring[keyId]))throw Error();key=Buffer.from(ring[keyId],'hex');}catch{return fail(503,'PUSH_STORAGE_UNAVAILABLE');}
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
  return JSON.stringify({version:1,keyId,iv:iv.toString('hex'),data:Buffer.concat([cipher.update(token,'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('hex')});
}
type Client=PrismaClient & {hostMobilePushDevice:any;hostMobilePushPreference:any};
// Called only after the HTTP boundary verifies a current ENFORCE session and Host role.
export function createHostPushRegistry(db:PrismaClient,env:Env){
  const prisma=db as Client;
  return {
    async register(actor:PushActor,body:unknown,now=new Date()){
      const input=parsePushRegistration(body),tokenHash=createHash('sha256').update(input.token).digest('hex');
      const tokenCiphertext=sealToken(env,JSON.stringify([actor.orgId,actor.id,actor.sessionId,tokenHash]),input.token);
      // Possession of the push token permits rebinding that token on account switch; old actor/session ownership is replaced atomically.
      await prisma.hostMobilePushDevice.upsert({where:{tokenHash},create:{id:randomUUID(),userId:actor.id,organizationId:actor.orgId,sessionId:actor.sessionId,tokenHash,tokenCiphertext,platform:input.platform,projectId:PROJECT,expiresAt:new Date(now.getTime()+30*86400000)},update:{userId:actor.id,organizationId:actor.orgId,sessionId:actor.sessionId,tokenCiphertext,platform:input.platform,projectId:PROJECT,revokedAt:null,expiresAt:new Date(now.getTime()+30*86400000)}});
      return {registered:true};
    },
    async revokeSession(actor:PushActor,now=new Date()){
      await prisma.hostMobilePushDevice.updateMany({where:{userId:actor.id,organizationId:actor.orgId,sessionId:actor.sessionId,revokedAt:null},data:{revokedAt:now}});
      return {revoked:true};
    },
    async preference(actor:PushActor){
      const row=await prisma.hostMobilePushPreference.findFirst({where:{userId:actor.id,organizationId:actor.orgId}});
      return row?{enabled:row.enabled,kinds:row.kinds,timezone:row.timezone,quietHours:row.quietStartHour===null?null:{startHour:row.quietStartHour,endHour:row.quietEndHour,allowCritical:row.allowCritical},revision:row.revision}:{enabled:false,kinds:[],timezone:'UTC',quietHours:null,revision:0};
    },
    async savePreference(actor:PushActor,body:unknown){
      const {expectedRevision,...data}=parsePushPreference(body);
      try{
        await prisma.$transaction(async(tx:any)=>{
          const row=await tx.hostMobilePushPreference.findUnique({where:{userId:actor.id}});
          if(row&&(row.organizationId!==actor.orgId||row.revision!==expectedRevision)||!row&&expectedRevision!==0)return fail(409,'PUSH_PREFERENCE_CONFLICT');
          if(!row)await tx.hostMobilePushPreference.create({data:{userId:actor.id,organizationId:actor.orgId,...data,revision:1}});
          else{const result=await tx.hostMobilePushPreference.updateMany({where:{userId:actor.id,organizationId:actor.orgId,revision:expectedRevision},data:{...data,revision:expectedRevision+1}});if(result.count!==1)return fail(409,'PUSH_PREFERENCE_CONFLICT');}
        },{isolationLevel:'Serializable'});
      }catch(error:any){if(error?.code==='P2034'||error?.code==='P2002')return fail(409,'PUSH_PREFERENCE_CONFLICT');throw error;}
      return {saved:true,revision:expectedRevision+1};
    },
  };
}
