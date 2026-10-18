import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {PrismaClient} from '@prisma/client';
import {createHostPushRegistry} from '../../services/host-mobile-notification.registry.js';
const enabled=process.env.PIN_AI_HOST_INCIDENT_DB_TEST==='true';
const url=new URL(process.env.DATABASE_URL??'http://missing');
if(enabled&&(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/pin_ai_host_incident_test'))throw Error('Isolated local host database required');
test('PostgreSQL push registry enforces token uniqueness, preference CAS and session-scoped retirement',{skip:!enabled},async()=>{
  const db=new PrismaClient(),p=db as any;
  const org=await db.organization.create({data:{name:'Synthetic push registry'}});
  const user=await db.dashboardUser.create({data:{organizationId:org.id,email:`${randomUUID()}@example.invalid`,passwordHash:'synthetic',role:'ORG_ADMIN'}});
  const actor={id:user.id,orgId:org.id,sessionId:'synthetic-session'};
  const registry=createHostPushRegistry(db,{HOST_MOBILE_PUSH_TOKEN_KEY_ID:'test',HOST_MOBILE_PUSH_TOKEN_KEYS:JSON.stringify({test:'ab'.repeat(32)})});
  const input={token:`ExpoPushToken[synthetic_${randomUUID().replace(/-/g,'')}]`,platform:'android',projectId:'f7037a5c-4526-46d7-b7bb-fb56e2be2f8f'};
  try{
    await Promise.all([registry.register(actor,input),registry.register(actor,input)]);assert.equal(await p.hostMobilePushDevice.count({where:{userId:user.id}}),1);
    const row=await p.hostMobilePushDevice.findFirst({where:{userId:user.id}});assert.ok(row.tokenCiphertext);assert.equal(row.tokenCiphertext.includes(input.token),false);
    assert.equal((await registry.deviceStatus(actor,input)).device.registered,true);
    assert.equal((await registry.deviceStatus({...actor,sessionId:'new-session'},input)).device.registered,false);
    assert.equal((await registry.deviceStatus({...actor,orgId:'other-org'},input)).device.registered,false);
    assert.equal((await registry.deviceStatus(actor,input,new Date(row.expiresAt))).device.registered,false);
    assert.equal((await p.hostMobilePushDevice.findUnique({where:{id:row.id}})).bindingVersion,row.bindingVersion,'status never rebinds or renews');
    const pref={enabled:true,kinds:['GUEST_INCIDENT'],timezone:'UTC',quietHours:null,expectedRevision:0};
    const result=await Promise.allSettled([registry.savePreference(actor,pref),registry.savePreference(actor,pref)]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal((await registry.preference(actor)).revision,1);
    await registry.revokeSession({...actor,sessionId:'different'});assert.equal((await p.hostMobilePushDevice.findUnique({where:{id:row.id}})).revokedAt,null);
    await registry.revokeSession(actor);assert.ok((await p.hostMobilePushDevice.findUnique({where:{id:row.id}})).revokedAt);
    assert.equal((await registry.deviceStatus(actor,input)).device.registered,false);
  }finally{await db.dashboardUser.delete({where:{id:user.id}});await db.organization.delete({where:{id:org.id}});await db.$disconnect();}
});

