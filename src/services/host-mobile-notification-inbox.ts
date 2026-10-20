import {Prisma, type PrismaClient} from '@prisma/client';
import {HostPushRegistryError, type PushActor} from './host-mobile-notification.registry.js';

const kinds = ['NEW_RESERVATION','GUEST_INCIDENT','GUEST_MESSAGE','CLEANING_EXCEPTION','ACCESS_EXCEPTION'];
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const invalid = (): never => {throw new HostPushRegistryError(400,'NOTIFICATION_INBOX_INVALID');};
type Cursor = {at: string; eventId: string; propertyId: string};
export function parseInboxQuery(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const q = value as Record<string,unknown>;
  if (Object.keys(q).some(k=>!['filter','cursor'].includes(k)) || q.filter !== undefined && !['all','unread'].includes(String(q.filter))) return invalid();
  let cursor: Cursor | null = null;
  if (q.cursor !== undefined) {
    if (typeof q.cursor !== 'string' || q.cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(q.cursor)) return invalid();
    try {
      const c = JSON.parse(Buffer.from(q.cursor,'base64url').toString()) as Cursor;
      if (!c || !id(c.eventId) || !id(c.propertyId) || typeof c.at !== 'string' || !Number.isFinite(Date.parse(c.at)) || new Date(c.at).toISOString() !== c.at) return invalid();
      cursor = {at:c.at,eventId:c.eventId,propertyId:c.propertyId};
    } catch {return invalid();}
  }
  return {unread:q.filter==='unread',cursor};
}
export function parseInboxRead(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const v=value as Record<string,unknown>;
  if (Object.keys(v).length!==2 || !id(v.eventId) || !id(v.propertyId)) return invalid();
  return {eventId:v.eventId,propertyId:v.propertyId};
}
type Row = {eventId:string;propertyId:string;propertyName:string;kind:string;occurredAt:Date;readAt:Date|null};
// A provider handoff is history, never proof of physical presentation. Only
// metadata is projected; no token, delivery id, guest text or provider ticket.
function history(actor:PushActor) {
  return Prisma.sql`SELECT d."eventId", d."propertyId", p."name" AS "propertyName", d."kind", MIN(d."occurredAt") AS "occurredAt", r."readAt"
    FROM "HostMobilePushDelivery" d
    JOIN "Property" p ON p."id"=d."propertyId" AND p."organizationId"=d."organizationId" AND p."status"='ACTIVE'
    LEFT JOIN "HostMobileNotificationRead" r ON r."organizationId"=d."organizationId" AND r."userId"=d."userId"
      AND r."propertyId"=d."propertyId" AND r."eventId"=d."eventId"
    WHERE d."organizationId"=${actor.orgId} AND d."userId"=${actor.id}
      AND d."acceptedAt" IS NOT NULL AND d."occurredAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
      AND d."occurredAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      AND d."kind" IN (${Prisma.join(kinds)})
    GROUP BY d."eventId",d."propertyId",p."name",d."kind",r."readAt"`;
}
export function createHostNotificationInbox(db:PrismaClient) {
  return {
    async reservation(actor:PushActor,query:unknown) {
      const {eventId,propertyId}=parseInboxRead(query);
      const rows=await db.$queryRaw<{reservationId:string}[]>(Prisma.sql`
        SELECT DISTINCT r."id" AS "reservationId" FROM "HostMobilePushDelivery" d
        JOIN "HostMobileReservationEvent" e ON d."sourceId"='reservation:' || e."reservationId"
          AND e."organizationId"=d."organizationId" AND e."propertyId"=d."propertyId"
        JOIN "Reservation" r ON r."id"=e."reservationId" AND r."propertyId"=e."propertyId"
        JOIN "Property" p ON p."id"=r."propertyId" AND p."organizationId"=d."organizationId" AND p."status"='ACTIVE'
        WHERE d."organizationId"=${actor.orgId} AND d."userId"=${actor.id}
          AND d."eventId"=${eventId} AND d."propertyId"=${propertyId} AND d."kind"='NEW_RESERVATION'
          AND d."acceptedAt" IS NOT NULL AND d."occurredAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '30 days'`);
      if(rows.length!==1)throw new HostPushRegistryError(404,'NOTIFICATION_NOT_FOUND');
      return {reservationId:rows[0]!.reservationId,propertyId};
    },
    async list(actor:PushActor,query:unknown) {
      const {unread,cursor}=parseInboxQuery(query);
      return db.$transaction(async tx=>{
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
        const base=history(actor);
        const counts=await tx.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*) AS count FROM (${base}) h WHERE h."readAt" IS NULL`);
        const rows=await tx.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM (${base}) h WHERE true
          ${unread?Prisma.sql`AND h."readAt" IS NULL`:Prisma.empty}
          ${cursor?Prisma.sql`AND (h."occurredAt",h."eventId",h."propertyId") < (${cursor.at.slice(0,-1)}::timestamp,${cursor.eventId},${cursor.propertyId})`:Prisma.empty}
          ORDER BY h."occurredAt" DESC,h."eventId" DESC,h."propertyId" DESC LIMIT 26`);
        const items=rows.slice(0,25),last=items.at(-1);
        return {items:items.map(r=>({...r,occurredAt:r.occurredAt.toISOString(),readAt:r.readAt?.toISOString()??null})),
          unreadCount:Number(counts[0]?.count??0),
          nextCursor:rows.length>25&&last?Buffer.from(JSON.stringify({at:last.occurredAt.toISOString(),eventId:last.eventId,propertyId:last.propertyId})).toString('base64url'):null};
      },{isolationLevel:'RepeatableRead',timeout:10000});
    },
    async markRead(actor:PushActor,body:unknown) {
      const {eventId,propertyId}=parseInboxRead(body);
      // Authorization and existence are evaluated in the same INSERT. Repeats
      // preserve the first timestamp; no message or source status is updated.
      const rows=await db.$queryRaw<{readAt:Date}[]>(Prisma.sql`INSERT INTO "HostMobileNotificationRead"
        ("organizationId","userId","propertyId","eventId","readAt")
        SELECT ${actor.orgId},${actor.id},h."propertyId",h."eventId",(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        FROM (${history(actor)}) h WHERE h."eventId"=${eventId} AND h."propertyId"=${propertyId}
        ON CONFLICT ("organizationId","userId","propertyId","eventId") DO UPDATE SET "readAt"="HostMobileNotificationRead"."readAt"
        RETURNING "readAt"`);
      if (rows.length!==1) throw new HostPushRegistryError(404,'NOTIFICATION_NOT_FOUND');
      return {eventId,propertyId,readAt:rows[0]!.readAt.toISOString()};
    },
  };
}
