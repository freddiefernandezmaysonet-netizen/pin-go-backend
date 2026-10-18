import assert from 'node:assert/strict';
import test from 'node:test';
import {createHostPushRegistry,parsePushPreference,parsePushRegistration} from '../../services/host-mobile-notification.registry.js';
const actor={id:'host',orgId:'organization',sessionId:'session'};
const registration={token:'ExpoPushToken[synthetic_token_123456789]',platform:'ios',projectId:'f7037a5c-4526-46d7-b7bb-fb56e2be2f8f'};
const env={HOST_MOBILE_PUSH_TOKEN_KEY_ID:'test',HOST_MOBILE_PUSH_TOKEN_KEYS:JSON.stringify({test:'ab'.repeat(32)})};
function fixture(){
  const devices=new Map<string,any>();let preference:any=null;
  const db:any={hostMobilePushDevice:{upsert:async({where,create,update}:any)=>{devices.set(where.tokenHash,devices.has(where.tokenHash)?{...devices.get(where.tokenHash),...update}:create);},updateMany:async({where,data}:any)=>{let count=0;for(const [key,row]of devices)if(Object.entries(where).every(([k,v])=>(row[k]??null)===v)){devices.set(key,{...row,...data});count++;}return{count};}},
    hostMobilePushPreference:{findFirst:async({where}:any)=>preference&&preference.userId===where.userId&&preference.organizationId===where.organizationId?preference:null,findUnique:async()=>preference,create:async({data}:any)=>{preference=data;},updateMany:async({where,data}:any)=>{if(!preference||!Object.entries(where).every(([k,v])=>preference[k]===v))return{count:0};preference={...preference,...data};return{count:1};}}};
  db.$transaction=async(run:any)=>run(db);
  return{devices,registry:createHostPushRegistry(db,env),db};
}
test('registration stores encrypted token and scoped metadata, is idempotent and exposes no token',async()=>{
  const f=fixture();assert.deepEqual(await f.registry.register(actor,registration),{registered:true});await f.registry.register(actor,registration);assert.equal(f.devices.size,1);
  const row=[...f.devices.values()][0];assert.equal(row.userId,'host');assert.equal(row.sessionId,'session');assert.equal(row.organizationId,'organization');assert.equal(JSON.stringify(row).includes(registration.token),false);assert.equal(row.tokenHash.length,64);assert.equal(JSON.parse(row.tokenCiphertext).keyId,'test');
});
test('account switch replaces token ownership and old session cannot revoke new binding',async()=>{
  const f=fixture();await f.registry.register(actor,registration);await f.registry.register({...actor,id:'second-host',sessionId:'second-session'},registration);await f.registry.revokeSession(actor);
  let row=[...f.devices.values()][0];assert.equal(row.userId,'second-host');assert.equal(row.revokedAt,null);
  await f.registry.revokeSession({...actor,id:'second-host',sessionId:'second-session'});row=[...f.devices.values()][0];assert.ok(row.revokedAt instanceof Date);
});
test('missing encryption configuration and invalid scope/project token never write',async()=>{
  const f=fixture();await assert.rejects(createHostPushRegistry(f.db,{}).register(actor,registration),/PUSH_STORAGE_UNAVAILABLE/);assert.equal(f.devices.size,0);
  for(const change of [{token:'bad'},{platform:'web'},{projectId:'88ee7224-8993-4ab6-9675-7777ec7d0890'},{organizationId:'other'}])assert.throws(()=>parsePushRegistration({...registration,...change}),/INVALID/);
});
const preference={enabled:true,kinds:['GUEST_INCIDENT'],timezone:'America/Puerto_Rico',quietHours:{startHour:22,endHour:8,allowCritical:false},expectedRevision:0};
test('preferences default off and use exact actor scope with version conflicts',async()=>{
  const f=fixture();assert.equal((await f.registry.preference(actor)).enabled,false);
  assert.deepEqual(await f.registry.savePreference(actor,preference),{saved:true,revision:1});assert.equal((await f.registry.preference(actor)).enabled,true);
  await assert.rejects(f.registry.savePreference(actor,preference),/CONFLICT/);
  await assert.rejects(f.registry.savePreference({...actor,orgId:'other'},{...preference,expectedRevision:1}),/CONFLICT/);
  assert.equal((await f.registry.preference({...actor,orgId:'other'})).enabled,false);
  await f.registry.savePreference(actor,{...preference,enabled:false,expectedRevision:1});assert.equal((await f.registry.preference(actor)).enabled,false);
});
test('preference parsing rejects invalid timezone, extra authority fields and quiet settings',()=>{
  for(const change of [{timezone:'Invalid/Timezone'},{expectedRevision:-1},{userId:'other'},{enabled:'yes'},{kinds:['UNLOCK']},{kinds:['GUEST_INCIDENT','GUEST_INCIDENT']},{quietHours:{startHour:8,endHour:8,allowCritical:false}}])assert.throws(()=>parsePushPreference({...preference,...change}),/INVALID/);
});
