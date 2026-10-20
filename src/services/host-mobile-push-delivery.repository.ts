import {createHash, randomUUID} from 'node:crypto';
import {Prisma, type PrismaClient, type HostMobilePushDelivery} from '@prisma/client';
import {permitsHostPushBinding} from './host-mobile-push-authorization.js';
import {HOST_PUSH_PROJECT, type EncryptedHostPushDevice} from './host-mobile-push-token.js';
import type {HostAttentionEvent, HostAttentionKind, HostPushPreference, HostPushRecipient} from './host-mobile-notification.policy.js';

export type Delivery = HostMobilePushDelivery;
export type PushSnapshot = {
  event: HostAttentionEvent; recipient: HostPushRecipient; preference: HostPushPreference;
  message?: {threadId: string; messageId: string; sourceRevision: Date; threadRevision: Date};
  messageVerifiedAt?: Date;
  preferenceRevision: number; device: EncryptedHostPushDevice; checkedAt: Date;
};
export type DeliveryFinish = {
  state: 'QUEUED' | 'ACCEPTED' | 'PROVIDER_ACCEPTED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';
  code: string; delayMs?: number; ticketId?: string; retireDevice?: boolean;
};
export type HostPushDeliveryRepository = {
  recover(): Promise<void>;
  materialize(propertyIds: readonly string[], notBefore: Date): Promise<number>;
  claim(mode: 'SEND' | 'RECEIPT', owner: string): Promise<Delivery | null>;
  current(delivery: Delivery): Promise<PushSnapshot | null>;
  arm(delivery: Delivery, snapshot: PushSnapshot): Promise<boolean>;
  finish(delivery: Delivery, outcome: DeliveryFinish): Promise<boolean>;
};

const kindSql = Prisma.sql`CASE WHEN i."engine" = 'HOST_RESERVATION' THEN 'NEW_RESERVATION' WHEN i."engine" = 'HOST_PUSH_INBOUND' THEN 'GUEST_MESSAGE' WHEN i."engine" = 'PIN_AI_GUEST_INCIDENT' THEN 'GUEST_INCIDENT'
  WHEN i."actionTarget" = 'CLEANING' THEN 'CLEANING_EXCEPTION'
  WHEN i."actionTarget" = 'ACCESS' THEN 'ACCESS_EXCEPTION' ELSE NULL END`;
function issueKind(source: {engine: string; actionTarget: string}): HostAttentionKind | null {
  if (source.engine === 'HOST_RESERVATION') return 'NEW_RESERVATION';
  if (source.engine === 'HOST_PUSH_INBOUND') return 'GUEST_MESSAGE';
  if (source.engine === 'PIN_AI_GUEST_INCIDENT') return 'GUEST_INCIDENT';
  if (source.actionTarget === 'CLEANING') return 'CLEANING_EXCEPTION';
  if (source.actionTarget === 'ACCESS') return 'ACCESS_EXCEPTION';
  // MESSAGING operational failures are not inbound guest messages.
  return null;
}

// Normalize only canonical NEEDS_HOST inputs; no outbound failure is a message.
// This optional view is never queried when inbound push is disabled.
function attentionSources(messagesEnabled: boolean, reservationsEnabled: boolean) {
  let issues = Prisma.sql`SELECT "id", "reopenedCount", "organizationId", "propertyId", "engine", "actionTarget"::text,
    "visibility"::text, "workflowState"::text, "actionRequired", "resolvedAt", "severity"::text, "lastSignalAt",
    NULL::text AS "threadId", NULL::text AS "messageId", NULL::timestamp AS "sourceRevision", NULL::timestamp AS "threadRevision"
    FROM "OperationalIssue"`;
  if (reservationsEnabled) issues = Prisma.sql`${issues} UNION ALL
    SELECT 'reservation:' || e."reservationId", 0, e."organizationId", e."propertyId",
      'HOST_RESERVATION', 'RESERVATION', 'HOST', 'INFORMATIONAL', false, NULL::timestamp, 'INFO', e."occurredAt",
      NULL::text, NULL::text, NULL::timestamp, NULL::timestamp
    FROM "HostMobileReservationEvent" e JOIN "Reservation" r ON r."id"=e."reservationId" AND r."propertyId"=e."propertyId"
    WHERE e."occurredAt" IS NOT NULL AND r."status"='ACTIVE' AND r."checkOut">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      AND (COALESCE(r."source", '') <> 'DIRECT_BOOKING' AND COALESCE(r."externalProvider", '') <> 'PIN_GO_DIRECT' OR r."paymentState"='PAID')`;
  if (!messagesEnabled) return Prisma.sql`(${issues})`;
  return Prisma.sql`(${issues} UNION ALL SELECT 'inbound:' || m."id", 0, m."organizationId", m."propertyId",
    'HOST_PUSH_INBOUND', 'MESSAGING', 'HOST', 'ACTION_REQUIRED', true, NULL::timestamp, 'INFO', m."receivedAt",
    m."threadId", m."messageId", m."updatedAt", t."updatedAt"
    FROM "ChannexAIInbound" m JOIN "ChannexAIThread" t ON t."organizationId" = m."organizationId"
      AND t."propertyId" = m."propertyId" AND t."threadId" = m."threadId"
    WHERE m."status" = 'NEEDS_HOST' AND t."mode" = 'HUMAN' AND t."sending" = false
      AND m."leaseToken" IS NULL AND t."leaseToken" IS NULL)`;
}
export function createHostPushDeliveryRepository(db: PrismaClient, messagesEnabled = false, reservationsEnabled = false): HostPushDeliveryRepository {
  const sources = attentionSources(messagesEnabled, reservationsEnabled);
  return {
    async recover() {
      // A process may die on either side of the network boundary. Only a claim
      // that never reached SENDING is replayable. Receipt reads cannot resend.
      await db.$executeRaw`UPDATE "HostMobilePushDelivery" SET
        "state" = CASE "state" WHEN 'SENDING' THEN 'UNKNOWN' WHEN 'CHECKING' THEN 'ACCEPTED' ELSE 'QUEUED' END,
        "outcomeCode" = CASE WHEN "state" = 'SENDING' THEN 'SEND_LEASE_EXPIRED' ELSE 'LEASE_RECOVERED' END,
        "leaseOwner" = NULL, "leaseUntil" = NULL, "availableAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        WHERE "state" IN ('CLAIMED','SENDING','CHECKING') AND "leaseUntil" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;
      await db.$executeRaw`UPDATE "HostMobilePushDelivery" SET "state" = 'SKIPPED', "outcomeCode" = 'EVENT_EXPIRED', "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        WHERE "state" = 'QUEUED' AND "expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;
      await db.$executeRaw`UPDATE "HostMobilePushDelivery" SET "state" = 'UNKNOWN', "outcomeCode" = 'RECEIPT_EXPIRED', "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        WHERE "state" = 'ACCEPTED' AND "receiptDeadline" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;
    },
    async materialize(propertyIds, notBefore) {
      if (!propertyIds.length) return 0;
      type Candidate = Pick<Delivery, 'sourceId' | 'sourceEpoch' | 'organizationId' | 'propertyId' | 'userId' | 'sessionId' | 'deviceId' | 'deviceUpdatedAt' | 'deviceBindingVersion' | 'kind' | 'occurredAt'>;
      const candidates = await db.$queryRaw<Candidate[]>(Prisma.sql`
        SELECT i."id" AS "sourceId", i."reopenedCount" AS "sourceEpoch", i."organizationId", i."propertyId",
          d."userId", d."sessionId", d."id" AS "deviceId", d."updatedAt" AS "deviceUpdatedAt", d."bindingVersion" AS "deviceBindingVersion",
          ${kindSql} AS "kind", i."lastSignalAt" AS "occurredAt"
        FROM ${sources} i
        JOIN "Property" p ON p."id" = i."propertyId" AND p."organizationId" = i."organizationId" AND p."status" = 'ACTIVE'
        JOIN "HostMobilePushDevice" d ON d."organizationId" = i."organizationId"
        JOIN "DashboardUser" u ON u."id" = d."userId" AND u."organizationId" = d."organizationId"
        JOIN "HostMobilePushPreference" f ON f."userId" = u."id" AND f."organizationId" = u."organizationId"
        WHERE i."propertyId" IN (${Prisma.join([...propertyIds])})
          AND i."visibility" = 'HOST' AND ((i."workflowState" = 'ACTION_REQUIRED' AND i."actionRequired" = true) OR
            (i."engine" = 'HOST_RESERVATION' AND i."workflowState" = 'INFORMATIONAL')) AND i."resolvedAt" IS NULL
          AND i."lastSignalAt" >= ${notBefore.toISOString().slice(0, -1)}::timestamp AND i."lastSignalAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          AND i."lastSignalAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '24 hours'
          AND d."revokedAt" IS NULL AND (d."expiresAt" IS NULL OR d."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AND d."projectId" = ${HOST_PUSH_PROJECT}
          AND u."isActive" = true AND u."role" IN ('ORG_ADMIN','ADMIN','PLATFORM_ADMIN')
          AND f."enabled" = true AND ${kindSql} = ANY(f."kinds")
          ${messagesEnabled ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "HostMobileMessageRead" r
            WHERE r."organizationId" = i."organizationId" AND r."userId" = d."userId" AND r."propertyId" = i."propertyId"
              AND r."threadId" = i."threadId" AND r."messageId" = i."messageId")` : Prisma.empty}
          AND NOT EXISTS (SELECT 1 FROM "HostMobilePushDelivery" o WHERE o."sourceId" = i."id"
            AND o."sourceEpoch" = i."reopenedCount" AND o."deviceId" = d."id" AND o."userId" = d."userId")
        ORDER BY i."lastSignalAt", i."id", d."id" LIMIT 100`);
      if (!candidates.length) return 0;
      const result = await db.hostMobilePushDelivery.createMany({skipDuplicates: true, data: candidates.map(row => ({
        ...row, id: randomUUID(), eventId: `host_${createHash('sha256').update(JSON.stringify([row.sourceId, row.sourceEpoch])).digest('hex')}`,
        expiresAt: new Date(row.occurredAt.getTime() + 24 * 60 * 60_000),
      }))});
      return result.count;
    },
    async claim(mode, owner) {
      const state = mode === 'SEND' ? 'QUEUED' : 'ACCEPTED';
      const next = mode === 'SEND' ? 'CLAIMED' : 'CHECKING';
      const rows = await db.$queryRaw<Delivery[]>`WITH candidate AS (
        SELECT "id" FROM "HostMobilePushDelivery"
        WHERE "state" = ${state} AND "availableAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          AND ((${mode} = 'SEND' AND "expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
            OR (${mode} = 'RECEIPT' AND "receiptDeadline" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND "ticketId" IS NOT NULL))
        ORDER BY "availableAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE "HostMobilePushDelivery" o SET "state" = ${next}, "leaseOwner" = ${owner},
        "leaseEpoch" = o."leaseEpoch" + 1, "leaseUntil" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '45 seconds', "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        FROM candidate WHERE o."id" = candidate."id" RETURNING o.*`;
      return rows[0] ?? null;
    },
    async current(delivery) {
      return db.$transaction(async tx => {
        const [clock] = await tx.$queryRaw<{now: Date}[]>`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS now`;
        const now = clock!.now;
        const [device, user, source, preference, property] = await Promise.all([
          tx.hostMobilePushDevice.findUnique({where: {id: delivery.deviceId}}),
          tx.dashboardUser.findUnique({where: {id: delivery.userId}}),
          tx.$queryRaw<Array<{organizationId: string; propertyId: string; engine: string; actionTarget: string;
            visibility: string; workflowState: string; actionRequired: boolean; resolvedAt: Date | null; reopenedCount: number;
            severity: 'INFO' | 'WARNING' | 'CRITICAL'; threadId: string | null; messageId: string | null;
            sourceRevision: Date; threadRevision: Date}>>(Prisma.sql`SELECT * FROM ${sources} i WHERE i."id" = ${delivery.sourceId}`)
            .then(rows => rows.length === 1 ? rows[0] : null),
          tx.hostMobilePushPreference.findUnique({where: {userId: delivery.userId}}),
          tx.property.findFirst({where: {id: delivery.propertyId, organizationId: delivery.organizationId, status: 'ACTIVE'}, select: {id: true}}),
        ]);
        if (!device || !user || !source || !preference || !property || device.revokedAt || (device.expiresAt !== null && device.expiresAt <= now) ||
            device.updatedAt.getTime() !== delivery.deviceUpdatedAt.getTime() || device.bindingVersion !== delivery.deviceBindingVersion || device.userId !== delivery.userId ||
            device.organizationId !== delivery.organizationId || device.sessionId !== delivery.sessionId ||
            user.organizationId !== delivery.organizationId || !user.isActive || !['ORG_ADMIN','ADMIN','PLATFORM_ADMIN'].includes(user.role) ||
            preference.organizationId !== delivery.organizationId || source.organizationId !== delivery.organizationId ||
            source.propertyId !== delivery.propertyId || source.reopenedCount !== delivery.sourceEpoch || source.resolvedAt ||
            source.visibility !== 'HOST' || (source.engine === 'HOST_RESERVATION' ? source.workflowState !== 'INFORMATIONAL' : source.workflowState !== 'ACTION_REQUIRED' || !source.actionRequired) || issueKind(source) !== delivery.kind)
          return null;
        if (source.threadId && source.messageId && await tx.hostMobileMessageRead.findUnique({where: {
          organizationId_userId_propertyId_threadId_messageId: {organizationId: delivery.organizationId, userId: delivery.userId,
            propertyId: delivery.propertyId, threadId: source.threadId, messageId: source.messageId},
        }})) return null;
        const session = await tx.authSession.findUnique({where: {id: delivery.sessionId}});
        if (!permitsHostPushBinding(session, {sessionId: delivery.sessionId, userId: user.id,
          organizationId: user.organizationId, tokenVersion: user.tokenVersion}, now)) return null;
        // activeSession in the shared notification policy means an authorized
        // notification binding here; interactive HTTP authorization is unchanged.
        return {
          event: {id: delivery.eventId, organizationId: delivery.organizationId, propertyId: property.id,
            kind: delivery.kind as HostAttentionKind, actionRequired: source.actionRequired, state: source.engine === 'HOST_RESERVATION' ? 'INFORMATIONAL' : 'ACTION_REQUIRED', severity: source.severity, occurredAt: delivery.occurredAt},
          recipient: {userId: user.id, organizationId: user.organizationId, role: user.role, activeSession: true, allowedPropertyIds: [property.id]},
          preference: {enabled: preference.enabled, kinds: preference.kinds as HostAttentionKind[], timezone: preference.timezone,
            quietHours: preference.quietStartHour === null ? null : {startHour: preference.quietStartHour, endHour: preference.quietEndHour!, allowCritical: preference.allowCritical}},
          ...(source.threadId && source.messageId ? {message: {threadId: source.threadId, messageId: source.messageId,
            sourceRevision: source.sourceRevision, threadRevision: source.threadRevision}} : {}),
          preferenceRevision: preference.revision, device, checkedAt: now,
        };
      }, {isolationLevel: 'RepeatableRead', timeout: 10_000});
    },
    async arm(d, snapshot) {
      // Repeat critical authorization predicates at the durable network boundary.
      // The canonical policy snapshot must be under five seconds old, with the
      // same preference revision. No human session activity is touched here.
      if (d.kind === 'GUEST_MESSAGE' && (!messagesEnabled || !snapshot.message || !snapshot.messageVerifiedAt)) return false;
      const messageFence = d.kind === 'GUEST_MESSAGE' ? Prisma.sql`
        AND NOT EXISTS (SELECT 1 FROM "HostMobileMessageRead" r WHERE r."organizationId" = o."organizationId"
          AND r."userId" = o."userId" AND r."propertyId" = o."propertyId" AND r."threadId" = i."threadId" AND r."messageId" = i."messageId")
        AND i."sourceRevision" = ${snapshot.message!.sourceRevision.toISOString().slice(0, -1)}::timestamp
        AND i."threadRevision" = ${snapshot.message!.threadRevision.toISOString().slice(0, -1)}::timestamp
        AND i."threadId" = ${snapshot.message!.threadId} AND i."messageId" = ${snapshot.message!.messageId}
        AND ${snapshot.messageVerifiedAt!.toISOString().slice(0, -1)}::timestamp <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND ${snapshot.messageVerifiedAt!.toISOString().slice(0, -1)}::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '5 seconds'
      ` : Prisma.empty;
      const count = await db.$executeRaw`UPDATE "HostMobilePushDelivery" o
        SET "state" = 'SENDING', "attempts" = "attempts" + 1, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        WHERE o."id" = ${d.id} AND o."state" = 'CLAIMED' AND o."leaseOwner" = ${d.leaseOwner}
          AND o."leaseEpoch" = ${d.leaseEpoch} AND o."leaseUntil" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND o."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          AND ${snapshot.checkedAt.toISOString().slice(0, -1)}::timestamp <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND ${snapshot.checkedAt.toISOString().slice(0, -1)}::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '5 seconds'
          AND EXISTS (SELECT 1 FROM "HostMobilePushDevice" v
            JOIN "DashboardUser" u ON u."id" = v."userId" AND u."organizationId" = v."organizationId"
            JOIN "AuthSession" s ON s."id" = v."sessionId" AND s."userId" = u."id" AND s."organizationId" = u."organizationId"
            JOIN "HostMobilePushPreference" f ON f."userId" = u."id" AND f."organizationId" = u."organizationId"
            JOIN "Property" p ON p."id" = o."propertyId" AND p."organizationId" = u."organizationId"
            JOIN ${sources} i ON i."id" = o."sourceId" AND i."organizationId" = p."organizationId" AND i."propertyId" = p."id"
            WHERE v."id" = o."deviceId" AND v."updatedAt" = o."deviceUpdatedAt" AND v."bindingVersion" = o."deviceBindingVersion" AND v."userId" = o."userId"
              AND v."sessionId" = o."sessionId" AND v."organizationId" = o."organizationId" AND v."revokedAt" IS NULL
              AND (v."expiresAt" IS NULL OR v."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AND v."projectId" = ${HOST_PUSH_PROJECT}
              AND v."platform" IN ('ios','android') AND u."isActive" = true AND u."role" IN ('ORG_ADMIN','ADMIN','PLATFORM_ADMIN')
              AND (s."revokedAt" IS NULL OR s."revokeReason" IN ('IDLE_TIMEOUT','ABSOLUTE_TIMEOUT')) AND s."tokenVersion" = u."tokenVersion"
              AND s."authenticatedAt" <= s."lastActivityAt" AND s."lastActivityAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
              AND p."status" = 'ACTIVE' AND f."enabled" = true AND f."revision" = ${snapshot.preferenceRevision}
              AND o."kind" = ANY(f."kinds") AND i."visibility" = 'HOST'
              AND ((i."workflowState"='ACTION_REQUIRED' AND i."actionRequired"=true)
                OR (i."engine"='HOST_RESERVATION' AND i."workflowState"='INFORMATIONAL')) AND i."resolvedAt" IS NULL AND i."reopenedCount" = o."sourceEpoch"
              AND i."severity"::text = ${snapshot.event.severity}
              AND ${kindSql} = o."kind" ${messageFence}
              AND (f."quietStartHour" IS NULL OR (f."allowCritical" = true AND i."severity" = 'CRITICAL') OR NOT (
                CASE WHEN f."quietStartHour" < f."quietEndHour" THEN
                  EXTRACT(HOUR FROM CURRENT_TIMESTAMP AT TIME ZONE f."timezone") >= f."quietStartHour"
                  AND EXTRACT(HOUR FROM CURRENT_TIMESTAMP AT TIME ZONE f."timezone") < f."quietEndHour"
                ELSE EXTRACT(HOUR FROM CURRENT_TIMESTAMP AT TIME ZONE f."timezone") >= f."quietStartHour"
                  OR EXTRACT(HOUR FROM CURRENT_TIMESTAMP AT TIME ZONE f."timezone") < f."quietEndHour" END))
          )`;
      return count === 1;
    },
    async finish(d, outcome) {
      return db.$transaction(async tx => {
        const [clock] = await tx.$queryRaw<{now: Date}[]>`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS now`;
        const now = clock!.now;
        const updated = await tx.hostMobilePushDelivery.updateMany({where: {
          id: d.id, state: {in: ['CLAIMED', 'SENDING', 'CHECKING']}, leaseOwner: d.leaseOwner, leaseEpoch: d.leaseEpoch, leaseUntil: {gt: now},
        }, data: {state: outcome.state, outcomeCode: outcome.code, leaseOwner: null, leaseUntil: null,
          availableAt: new Date(now.getTime() + (outcome.delayMs ?? 0)),
          ...(outcome.ticketId ? {ticketId: outcome.ticketId, acceptedAt: now, receiptDeadline: new Date(now.getTime() + 23 * 60 * 60_000)} : {}),
        }});
        if (updated.count !== 1) return false;
        if (outcome.retireDevice) await tx.hostMobilePushDevice.updateMany({where: {
          id: d.deviceId, userId: d.userId, organizationId: d.organizationId, sessionId: d.sessionId,
          updatedAt: d.deviceUpdatedAt, bindingVersion: d.deviceBindingVersion, revokedAt: null,
        }, data: {revokedAt: now}});
        return true;
      });
    },
  };
}

// Separate, explicitly invoked maintenance. It cannot enqueue, claim or send.
export async function maintainHostPushRecords(db: PrismaClient, organizationIds: readonly string[]) {
  if (!organizationIds.length) return {deliveriesDeleted: 0, devicesDeleted: 0};
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
    // Preserve the deduplication identity while its canonical source exists,
    // including resolved cases that may receive another signal. UNKNOWN is
    // evidence awaiting reconciliation and is never automatically deleted.
    const deliveriesDeleted = await tx.$executeRaw(Prisma.sql`WITH obsolete AS (
      SELECT o."id" FROM "HostMobilePushDelivery" o
      WHERE o."organizationId" IN (${Prisma.join([...organizationIds])})
        AND o."kind" NOT IN ('GUEST_MESSAGE','NEW_RESERVATION')
        AND o."state" IN ('PROVIDER_ACCEPTED','FAILED','SKIPPED')
        AND o."updatedAt" < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
        AND o."expiresAt" < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
        AND o."leaseOwner" IS NULL AND o."leaseUntil" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "OperationalIssue" i WHERE i."id" = o."sourceId")
      ORDER BY o."updatedAt", o."id" FOR UPDATE OF o SKIP LOCKED LIMIT 500
    ) DELETE FROM "HostMobilePushDelivery" o USING obsolete x WHERE o."id" = x."id"`);
    // Registration and deletion lock the same device row. A renewed binding
    // cannot qualify on a stale snapshot. Never delete merely idle live devices.
    const devicesDeleted = await tx.$executeRaw(Prisma.sql`WITH obsolete AS (
      SELECT d."id" FROM "HostMobilePushDevice" d
      WHERE d."organizationId" IN (${Prisma.join([...organizationIds])})
        AND d."updatedAt" < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
        AND (d."expiresAt" < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
          OR d."revokedAt" < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days')
      ORDER BY d."updatedAt", d."id" FOR UPDATE OF d SKIP LOCKED LIMIT 500
    ) DELETE FROM "HostMobilePushDevice" d USING obsolete x WHERE d."id" = x."id"`);
    return {deliveriesDeleted, devicesDeleted};
  }, {timeout: 10_000});
}
