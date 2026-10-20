// PGLITE_MODULE may point to an externally installed @electric-sql/pglite/dist/index.js.
// No production DB or push provider is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Prisma} from '@prisma/client';
import {createHostPushDeliveryRepository} from '../src/services/host-mobile-push-delivery.repository.ts';
import {createHostNotificationInbox} from '../src/services/host-mobile-notification-inbox.ts';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
test('reservation capture, deduplication, cancellation, consent, tenant isolation and verified destination',async()=>{
 const pg=new PGlite();
 try {
 await pg.exec(`
 CREATE TABLE "Property" (id text PRIMARY KEY,"organizationId" text,status text,name text);
 CREATE TABLE "Reservation" (id text PRIMARY KEY,"propertyId" text,status text,"checkOut" timestamp,source text,"externalProvider" text,"paymentState" text);
 INSERT INTO "Property" VALUES ('property','org','ACTIVE','Demo'),('other','other-org','ACTIVE','Other');
 INSERT INTO "Reservation" VALUES ('historical','property','ACTIVE',now()+interval '3 days','MANUAL',null,'NONE');
 CREATE TABLE "OperationalIssue" (id text,"reopenedCount" int,"organizationId" text,"propertyId" text,engine text,"actionTarget" text,visibility text,"workflowState" text,"actionRequired" boolean,"resolvedAt" timestamp,severity text,"lastSignalAt" timestamp);
 CREATE TABLE "HostMobilePushDevice" (id text,"userId" text,"organizationId" text,"sessionId" text,"updatedAt" timestamp,"bindingVersion" int,"revokedAt" timestamp,"expiresAt" timestamp,"projectId" text,platform text);
 CREATE TABLE "DashboardUser" (id text,"organizationId" text,"isActive" boolean,role text,"tokenVersion" int);
 CREATE TABLE "AuthSession" (id text,"userId" text,"organizationId" text,"revokedAt" timestamp,"tokenVersion" int,"authenticatedAt" timestamp,"lastActivityAt" timestamp);
 CREATE TABLE "HostMobilePushPreference" ("userId" text,"organizationId" text,enabled boolean,kinds text[],timezone text,revision int,"quietStartHour" int,"quietEndHour" int,"allowCritical" boolean);
 CREATE TABLE "HostMobilePushDelivery" (id text PRIMARY KEY,"sourceId" text,"sourceEpoch" int,"organizationId" text,"propertyId" text,"userId" text,"sessionId" text,"deviceId" text,"deviceUpdatedAt" timestamp,"deviceBindingVersion" int,kind text,"occurredAt" timestamp,"expiresAt" timestamp,"eventId" text,"acceptedAt" timestamp,state text DEFAULT 'QUEUED',"leaseOwner" text,"leaseEpoch" int DEFAULT 0,"leaseUntil" timestamp,attempts int DEFAULT 0,"updatedAt" timestamp DEFAULT now(), UNIQUE ("sourceId","sourceEpoch","deviceId","userId"));
 INSERT INTO "HostMobilePushDevice" VALUES ('device','user','org','session',now(),1,null,now()+interval '10 days','f7037a5c-4526-46d7-b7bb-fb56e2be2f8f','ios');
 INSERT INTO "DashboardUser" VALUES ('user','org',true,'ORG_ADMIN',1);
 INSERT INTO "AuthSession" VALUES ('session','user','org',null,1,now(),now());
 INSERT INTO "HostMobilePushPreference" VALUES ('user','org',true,ARRAY['NEW_RESERVATION'],'UTC',1,null,null,false);
 `);
 await pg.exec(await readFile(new URL('../prisma/migrations/20261020190000_host_reservation_notification/migration.sql',import.meta.url),'utf8'));
 const insert=async(id,source='MANUAL',payment='NONE',property='property',status='ACTIVE',past=false)=>pg.query(`INSERT INTO "Reservation" VALUES ($1,$2,$3,now()+$4::interval,$5,null,$6)`,[id,property,status,past?'-1 day':'3 days',source,payment]);
 const captured=async()=> (await pg.query(`SELECT * FROM "HostMobileReservationEvent" WHERE "occurredAt" IS NOT NULL ORDER BY "reservationId"`)).rows;
 await pg.exec(`UPDATE "Reservation" SET status='ACTIVE' WHERE id='historical'`);
 assert.equal((await captured()).length,0,'old rows are never backfilled');
 await insert('direct','DIRECT_BOOKING');assert.equal((await captured()).length,0,'unpaid checkout not confirmed');
 await pg.exec(`UPDATE "Reservation" SET "paymentState"='PAID' WHERE id='direct'`);
 const first=(await captured())[0].occurredAt;
 await pg.exec(`UPDATE "Reservation" SET "paymentState"='PAID',status='ACTIVE' WHERE id='direct'`);
 assert.deepEqual((await captured())[0].occurredAt,first,'webhook repeat preserves identity/time');
 await insert('ota','AIRBNB');await insert('manual');await insert('cancelled','MANUAL','NONE','property','CANCELLED');await insert('past','MANUAL','NONE','property','ACTIVE',true);await insert('foreign','MANUAL','NONE','other');
 assert.deepEqual((await captured()).map(r=>r.reservationId),['direct','foreign','manual','ota']);
 await pg.exec('BEGIN');await insert('rollback');await pg.exec('ROLLBACK');assert.equal((await captured()).some(r=>r.reservationId==='rollback'),false);
 const sql=(q,values)=>Array.isArray(q)?Prisma.sql(q,...values):q;
 const query=async(q,...v)=>{q=sql(q,v);return (await pg.query(q.text,q.values)).rows;};
 const execute=async(q,...v)=>{q=sql(q,v);return (await pg.query(q.text,q.values)).affectedRows;};
 const find=table=>async({where})=>(await pg.query(`SELECT * FROM "${table}" WHERE ${Object.keys(where).map((k,i)=>`"${k}"=$${i+1}`).join(' AND ')}`,Object.values(where))).rows[0]??null;
 const db={$queryRaw:query,$executeRaw:execute,$transaction:async fn=>fn(db),
   hostMobilePushDevice:{findUnique:find('HostMobilePushDevice')},dashboardUser:{findUnique:find('DashboardUser')},
   hostMobilePushPreference:{findUnique:find('HostMobilePushPreference')},property:{findFirst:find('Property')},authSession:{findUnique:find('AuthSession')},
   hostMobilePushDelivery:{createMany:async({data})=>{let count=0;for(const row of data){const keys=Object.keys(row);count+=(await pg.query(`INSERT INTO "HostMobilePushDelivery" (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT DO NOTHING`,Object.values(row))).affectedRows;}return {count};}}};
 const repo=createHostPushDeliveryRepository(db,false,true),since=new Date(Date.now()-3600000);
 assert.equal(await createHostPushDeliveryRepository(db).materialize(['property'],since),0,'off by default');
 assert.equal(await repo.materialize(['property','other'],since),3,'only own tenant, active eligible reservations');
 assert.equal(await repo.materialize(['property'],since),0,'durable deduplication');
 const [delivery]=await query(Prisma.sql`SELECT * FROM "HostMobilePushDelivery" WHERE "sourceId"='reservation:direct'`);
 const snapshot=await repo.current(delivery);assert.equal(snapshot.event.state,'INFORMATIONAL');
 await pg.exec(`UPDATE "HostMobilePushDelivery" SET state='CLAIMED',"leaseOwner"='test',"leaseEpoch"=1,"leaseUntil"=now()+interval '1 minute' WHERE id='${delivery.id}'`);
 const claimed={...delivery,leaseOwner:'test',leaseEpoch:1};
 await pg.exec(`UPDATE "HostMobilePushPreference" SET enabled=false`);
 assert.equal(await repo.arm(claimed,snapshot),false,'opt-out after snapshot fences send');
 await pg.exec(`UPDATE "HostMobilePushPreference" SET enabled=true; UPDATE "Reservation" SET status='CANCELLED' WHERE id='direct'`);
 assert.equal(await repo.current(delivery),null);assert.equal(await repo.arm(claimed,snapshot),false,'cancellation after snapshot fences send');
 await pg.exec(`UPDATE "Reservation" SET status='ACTIVE' WHERE id='direct'`);
 assert.equal(await repo.arm(claimed,await repo.current(delivery)),true,'eligible authorized reservation can send');
 const inbox=createHostNotificationInbox(db),actor={id:'user',orgId:'org',sessionId:'session'},hint={eventId:delivery.eventId,propertyId:'property'};
 await assert.rejects(inbox.reservation(actor,hint),/NOTIFICATION_NOT_FOUND/);
 await pg.query(`UPDATE "HostMobilePushDelivery" SET "acceptedAt"=now() WHERE id=$1`,[delivery.id]);
 assert.deepEqual(await inbox.reservation(actor,hint),{reservationId:'direct',propertyId:'property'});
 await assert.rejects(inbox.reservation({...actor,orgId:'other-org'},hint),/NOTIFICATION_NOT_FOUND/);
 await assert.rejects(inbox.reservation({...actor,id:'other-user'},hint),/NOTIFICATION_NOT_FOUND/);
 }finally{await pg.close();}
});
