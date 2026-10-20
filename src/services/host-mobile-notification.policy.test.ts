import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareHostAttentionNotification as prepare, type HostAttentionEvent, type HostPushPreference, type HostPushRecipient } from './host-mobile-notification.policy.js';
const now=new Date('2026-10-16T18:00:00Z');
const event: HostAttentionEvent={id:'signal-1',organizationId:'org-1',propertyId:'property-1',kind:'GUEST_INCIDENT',actionRequired:true,state:'ACTION_REQUIRED',severity:'WARNING',occurredAt:now};
const recipient: HostPushRecipient={userId:'host-1',organizationId:'org-1',role:'ORG_ADMIN',activeSession:true,allowedPropertyIds:['property-1']};
const preference: HostPushPreference={enabled:true,kinds:['GUEST_INCIDENT','GUEST_MESSAGE','CLEANING_EXCEPTION','ACCESS_EXCEPTION'],timezone:'America/Puerto_Rico',quietHours:{startHour:22,endHour:8,allowCritical:false}};
test('only prepares generic metadata, never private source text or provider calls',()=>{
  for(const kind of preference.kinds){const value=prepare({...event,kind,guestName:'PRIVATE',code:'1234567',text:'SECRET'} as HostAttentionEvent,recipient,preference,now);assert.equal(value.status,'PREPARED');if(value.status!=='PREPARED')return;assert.equal(value.payload.data.propertyId,'property-1');assert.equal(/PRIVATE|1234567|SECRET/.test(JSON.stringify(value)),false);assert.equal(value.payload.body,'Open Pin&Go Host to review the latest status.');}
});
test('tenant, property, current role, session and opt-out fail closed',()=>{
  for(const patch of [{organizationId:'other'},{allowedPropertyIds:[]},{activeSession:false},{role:'STAFF'}])assert.equal(prepare(event,{...recipient,...patch},preference,now).status,'SKIP');
  for(const patch of [{enabled:false},{kinds:[]}])assert.equal(prepare(event,recipient,{...preference,...patch},now).status,'SKIP');
});
test('autonomous, waiting, resolved and stale signals do not create alerts',()=>{
  for(const patch of [{actionRequired:false},{state:'AUTO_RESOLVING' as const},{state:'WAITING' as const},{state:'RESOLVED' as const},{occurredAt:new Date(now.getTime()-86400001)},{occurredAt:new Date(now.getTime()+1)}])assert.equal(prepare({...event,...patch},recipient,preference,now).status,'SKIP');
});
test('overnight quiet hours and critical bypass require explicit preference',()=>{
  const night=new Date('2026-10-17T03:00:00Z'), e={...event,occurredAt:night};
  assert.equal(prepare(e,recipient,preference,night).status,'DEFER');
  assert.equal(prepare({...e,severity:'CRITICAL'},recipient,preference,night).status,'DEFER');
  assert.equal(prepare({...e,severity:'CRITICAL'},recipient,{...preference,quietHours:{...preference.quietHours!,allowCritical:true}},night).status,'PREPARED');
  const morning=new Date('2026-10-17T12:00:00Z');assert.equal(prepare({...event,occurredAt:morning},recipient,preference,morning).status,'PREPARED');
});
test('invalid timezones and quiet settings cannot silently bypass restrictions',()=>{
  assert.equal(prepare(event,recipient,{...preference,timezone:'Invalid/Zone'},now).status,'SKIP');
  for(const startHour of [-1,24,8])assert.equal(prepare(event,recipient,{...preference,quietHours:{startHour,endHour:8,allowCritical:false}},now).status,'SKIP');
});
test('dedupe identity is stable and isolates actors and events',()=>{
  const a=prepare(event,recipient,preference,now),b=prepare(event,{...recipient,userId:'host-2'},preference,now),c=prepare({...event,id:'signal-2'},recipient,preference,now);
  assert.equal(a.status,'PREPARED');if(a.status!=='PREPARED'||b.status!=='PREPARED'||c.status!=='PREPARED')return;
  assert.deepEqual(prepare(event,recipient,preference,now),a);assert.notEqual(a.deduplicationKey,b.deduplicationKey);assert.notEqual(a.deduplicationKey,c.deduplicationKey);
});

test('new reservations are informational and respect opt-out, scope and quiet hours',()=>{
 const e:HostAttentionEvent={...event,kind:'NEW_RESERVATION',state:'INFORMATIONAL',actionRequired:false,severity:'INFO'};
 const p:HostPushPreference={...preference,kinds:['NEW_RESERVATION']};
 const prepared=prepare(e,recipient,p,now);
 assert.equal(prepared.status,'PREPARED');
 if(prepared.status==='PREPARED'){assert.equal(prepared.payload.title,'New reservation');assert.equal(prepared.payload.data.target,'reservation');}
 assert.equal(prepare(e,recipient,preference,now).status,'SKIP');
 assert.equal(prepare(e,{...recipient,organizationId:'other'},p,now).status,'SKIP');
 assert.equal(prepare({...e,state:'RESOLVED'},recipient,p,now).status,'SKIP');
 const night=new Date('2026-10-17T03:00:00Z');
 assert.equal(prepare({...e,occurredAt:night},recipient,p,night).status,'DEFER');
});
