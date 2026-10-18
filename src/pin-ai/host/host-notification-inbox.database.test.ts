import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {PrismaClient} from '@prisma/client';
import {createHostNotificationInbox,parseInboxQuery,parseInboxRead} from '../../services/host-mobile-notification-inbox.js';
const enabled=process.env.PIN_AI_HOST_INCIDENT_DB_TEST==='true';
const url=new URL(process.env.DATABASE_URL??'http://missing');
if(enabled&&(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/pin_ai_host_incident_test'))throw Error('Isolated local host database required');
test('inbox rejects malformed pagination and acknowledgement before database work',()=>{
  for(const q of [{filter:'other'},{cursor:['one']},{cursor:'abc'},{cursor:'?route=evil'},{extra:true}])assert.throws(()=>parseInboxQuery(q));
  for(const v of [null,{eventId:'event'},{eventId:'../event',propertyId:'property'},{eventId:'event',propertyId:'property',read:true}])assert.throws(()=>parseInboxRead(v));
  assert.deepEqual(parseInboxQuery({}),{unread:false,cursor:null});
});
test('PostgreSQL inbox deduplicates devices, persists exact reads, paginates and isolates actors',{skip:!enabled},async()=>{
  const db=new PrismaClient(),inbox=createHostNotificationInbox(db),prefix=randomUUID();
  const org=await db.organization.create({data:{name:'Synthetic inbox'}});
  const property=await db.property.create({data:{organizationId:org.id,name:'Synthetic inbox property'}});
  const actor={id:`host_${prefix}`,orgId:org.id,sessionId:'one'};
  const at=new Date(Date.now()-60000);
  const delivery=(eventId:string,deviceId:string,overrides:Record<string,unknown>={})=>({
    id:randomUUID(),sourceId:`source_${eventId}`,sourceEpoch:0,organizationId:org.id,propertyId:property.id,userId:actor.id,sessionId:'one',
    deviceId,deviceUpdatedAt:at,deviceBindingVersion:1,eventId,kind:'GUEST_INCIDENT',occurredAt:at,expiresAt:new Date(Date.now()+60000),
    state:'ACCEPTED',acceptedAt:at,...overrides,
  });
  try {
    await db.hostMobilePushDelivery.createMany({data:[
      delivery('event_shared','iphone'),delivery('event_shared','android'),delivery('event_other_host','other',{userId:'other'}),
      delivery('event_queued','queued',{acceptedAt:null,state:'QUEUED'}),
      delivery('event_expired','expired',{occurredAt:new Date(Date.now()-31*86400000)}),
      ...Array.from({length:27},(_,n)=>delivery(`event_${String(n).padStart(2,'0')}`,`device_${n}`)),
    ]});
    const first=await inbox.list(actor,{});assert.equal(first.unreadCount,28);assert.equal(first.items.length,25);assert.ok(first.nextCursor);
    const second=await inbox.list(actor,{cursor:first.nextCursor});assert.equal(second.items.length,3);assert.equal(second.nextCursor,null);
    const all=[...first.items,...second.items];assert.equal(new Set(all.map(r=>r.eventId)).size,28);
    assert.equal(all.filter(r=>r.eventId==='event_shared').length,1);
    assert.deepEqual(Object.keys(all[0]!).sort(),['eventId','propertyId','propertyName','kind','occurredAt','readAt'].sort());
    const body={eventId:'event_shared',propertyId:property.id};
    const marked=await Promise.all([inbox.markRead(actor,body),inbox.markRead(actor,body)]);assert.equal(marked[0]!.readAt,marked[1]!.readAt);
    assert.equal((await inbox.list({...actor,sessionId:'new-login'},{})).unreadCount,27,'read state survives login');
    const unread=await inbox.list(actor,{filter:'unread'});assert.equal(unread.unreadCount,27);assert.equal(unread.items.some(r=>r.eventId==='event_shared'),false);
    await assert.rejects(inbox.markRead({...actor,id:'other'},body));
    assert.equal((await inbox.list({...actor,orgId:'foreign'},{})).items.length,0);
    await assert.rejects(inbox.markRead({...actor,orgId:'foreign'},body));
    await assert.rejects(inbox.markRead(actor,{eventId:'event_queued',propertyId:property.id}));
    assert.equal(await db.hostMobileMessageRead.count({where:{organizationId:org.id}}),0,'inbox read never reads a guest message');
    await db.property.update({where:{id:property.id},data:{status:'INACTIVE'}});
    assert.equal((await inbox.list(actor,{})).unreadCount,0);await assert.rejects(inbox.markRead(actor,body));
  } finally {
    await db.hostMobileNotificationRead.deleteMany({where:{organizationId:org.id}});
    await db.hostMobilePushDelivery.deleteMany({where:{organizationId:org.id}});
    await db.property.delete({where:{id:property.id}});await db.organization.delete({where:{id:org.id}});await db.$disconnect();
  }
});
