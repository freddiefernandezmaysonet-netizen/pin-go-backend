import assert from 'node:assert/strict';
import test from 'node:test';
import { selectHostSessionPolicy, hostIdleTimeoutMs, hostCredentialLifetimeSeconds, hostCredentialNeedsRenewal } from './host-session.policy.js';
import { evaluateSessionSecurity } from './session-security.policy.js';
import { createAuthSession } from './trusted-device-session.persistence.js';
import { inspectBoundSession, touchBoundSessionHumanActivity } from './session-enforcement-runtime.js';
import { guardAuthenticatedSession } from './session-request-guard.js';
const DAY=86400000, start=new Date('2026-10-20T12:00:00Z');
const identity={sessionId:'session', userId:'host',organizationId:'org',tokenVersion:1};
function harness(policy='HOST_MOBILE_V1') {
  let row:any={id:'session',userId:'host',organizationId:'org',tokenVersion:1,sessionPolicy:policy,authenticatedAt:start,lastActivityAt:start,absoluteExpiresAt:new Date(+start+(hostIdleTimeoutMs(policy)??43200000)),revokedAt:null};
  const writes:any[]=[];
  const client:any={authSession:{findUnique:async()=>row,updateMany:async(args:any)=>{writes.push(args);if(row.revokedAt)return {count:0};Object.assign(row,args.data);return {count:1};},create:async({data}:any)=>{row={...data,id:'session',revokedAt:null};return {id:'session'};}},securityEvent:{create:async()=>({})},dashboardUser:{findUnique:async()=>({id:'host',organizationId:'org',tokenVersion:1,isActive:true,role:'ORG_ADMIN',email:'host@example.invalid',organization:null})}};
  return {client,writes,get row(){return row;}};
}
test('Host policy requires a renewal-capable native client; cleaner/platform retain legacy',()=>{
  assert.equal(selectHostSessionPolicy('ORG_ADMIN',true,true),'HOST_MOBILE_V1');
  assert.equal(selectHostSessionPolicy('ORG_ADMIN',true,false),'LEGACY');
  assert.equal(selectHostSessionPolicy('ORG_ADMIN',false,false),'HOST_WEB_V1');
  for(const role of ['CLEANER','PLATFORM_ADMIN','unknown'])assert.equal(selectHostSessionPolicy(role,true,true),'LEGACY');
});
test('new persistence records policy and rolling lease; default sessions retain 12h',async()=>{
  for(const policy of ['HOST_MOBILE_V1','HOST_WEB_V1','LEGACY'] as const){
    const h=harness();await createAuthSession(h.client,{...identity,sessionPolicy:policy,now:start});
    assert.equal(h.row.sessionPolicy,policy);
    assert.equal(+h.row.absoluteExpiresAt-+start,hostIdleTimeoutMs(policy)??43200000);
  }
});
test('mobile remains valid beyond 12h and expires at 30 days; web at 24h',()=>{
  for(const policy of ['HOST_MOBILE_V1','HOST_WEB_V1']){
    const idle=hostIdleTimeoutMs(policy)!;
    const state={authenticatedAt:start,lastActivityAt:start,sessionPolicy:policy};
    assert.equal(evaluateSessionSecurity(state,new Date(+start+idle-1)).valid,true);
    assert.equal(evaluateSessionSecurity(state,new Date(+start+idle)).valid,false);
  }
});
test('human activity renews across multiple months without a hidden absolute cap',async()=>{
  const h=harness();
  for(let day=29;day<=87;day+=29){
    const now=new Date(+start+day*DAY);
    assert.equal((await touchBoundSessionHumanActivity(h.client,{...identity,now})).touched,true);
    assert.equal(+h.row.absoluteExpiresAt,+now+30*DAY);
  }
  assert.equal((await inspectBoundSession(h.client,{...identity,now:new Date(+start+116*DAY)})).valid,true);
  assert.equal((await inspectBoundSession(h.client,{...identity,now:new Date(+start+117*DAY)})).valid,false);
});
test('web activity rolls its deadline and ordinary requests never extend it',async()=>{
  const h=harness('HOST_WEB_V1'),now=new Date(+start+23*3600000);
  assert.equal((await inspectBoundSession(h.client,{...identity,now})).valid,true);assert.equal(h.writes.length,0);
  await touchBoundSessionHumanActivity(h.client,{...identity,now});
  assert.equal(+h.row.absoluteExpiresAt,+now+DAY);
});
test('expired or revoked sessions cannot be renewed',async()=>{
  for(const revoked of [false,true]){
    const h=harness();if(revoked)h.row.revokedAt=start;
    const result=await touchBoundSessionHumanActivity(h.client,{...identity,now:new Date(+start+30*DAY)});
    assert.equal(result.valid,false);assert.equal(h.writes.length,0);
  }
});
test('signed rolling policy enforces expiry even with legacy SHADOW setting',async()=>{
  const h=harness();
  const result=await guardAuthenticatedSession(h.client,{...identity,requiredPolicy:'HOST_MOBILE_V1',mode:'SHADOW',now:new Date(+start+31*DAY)});
  assert.equal(result.kind,'DENY');assert.ok(h.row.revokedAt);
});
test('policy mismatch, missing binding and cross-account requests remain denied',async()=>{
  for(const extra of [{requiredPolicy:'HOST_WEB_V1'},{userId:'other'},{organizationId:'other-org'},{tokenVersion:2},{sessionId:null}]){
    const h=harness();const result=await guardAuthenticatedSession(h.client,{...identity,requiredPolicy:'HOST_MOBILE_V1',mode:'SHADOW',now:new Date(+start+1000),...extra});assert.equal(result.kind,'DENY');
  }
});
test('transport outlives idle window but policy still rejects unknown/tampered timelines',()=>{
  for(const policy of ['HOST_MOBILE_V1','HOST_WEB_V1'])assert.ok(hostCredentialLifetimeSeconds(policy)!*1000>hostIdleTimeoutMs(policy)!);
  assert.equal(evaluateSessionSecurity({authenticatedAt:start,lastActivityAt:start,sessionPolicy:'unknown'},start).valid,false);
  assert.equal(evaluateSessionSecurity({authenticatedAt:start,lastActivityAt:new Date(+start+1),sessionPolicy:'HOST_MOBILE_V1'},start).valid,false);
});

test('credentials refresh before they can truncate the idle lease, not on every touch',()=>{
  const policy='HOST_MOBILE_V1',issued=+start,expires=issued+31*DAY;
  assert.equal(hostCredentialNeedsRenewal(policy,expires,issued),false);
  assert.equal(hostCredentialNeedsRenewal(policy,expires,issued+DAY),true);
  assert.equal(hostCredentialNeedsRenewal(policy,undefined,issued),true);
  assert.equal(hostCredentialNeedsRenewal('LEGACY',undefined,issued),false);
});
