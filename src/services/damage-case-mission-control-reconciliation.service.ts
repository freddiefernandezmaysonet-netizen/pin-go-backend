import { Prisma, PrismaClient } from "@prisma/client";

import {
  resolveDamageCaseMaxMessageRetries,
  syncDamageCaseMissionControlSafely,
} from "./damage-case-mission-control.service.js";

type ReconciliationCandidate = {
  damageCaseId: string;
};

type CandidateFinder = (
  prisma: PrismaClient,
  batchSize: number,
  maxMessageRetries: number
) => Promise<ReconciliationCandidate[]>;

type DamageCaseSync = typeof syncDamageCaseMissionControlSafely;

export async function findDamageCaseMissionControlReconciliationCandidates(
  prisma: PrismaClient,
  batchSize: number,
  maxMessageRetries = Number(process.env.MESSAGE_MAX_RETRIES ?? 3)
): Promise<ReconciliationCandidate[]> {
  const boundedBatchSize = Math.max(1, Math.min(100, Math.trunc(batchSize)));
  const boundedMaxMessageRetries =
    resolveDamageCaseMaxMessageRetries(maxMessageRetries);

  return prisma.$queryRaw<ReconciliationCandidate[]>(Prisma.sql`
    SELECT dc."id" AS "damageCaseId"
    FROM "DamageCase" dc
    JOIN "Reservation" reservation
      ON reservation."id" = dc."reservationId"
    JOIN "Property" property
      ON property."id" = reservation."propertyId"
    LEFT JOIN "OperationalIssue" oi
      ON oi."operationalKey" = CONCAT(
        'PROPERTY_PROTECTION_DAMAGE_CASE:',
        dc."id"
      )
    LEFT JOIN LATERAL (
      SELECT ml."status", ml."retryCount"
      FROM "MessageLog" ml
      WHERE ml."reservationId" = dc."reservationId"
        AND ml."communicationType" =
          'PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE'
        AND ml."channel" = 'email'
      ORDER BY ml."createdAt" DESC, ml."id" DESC
      LIMIT 1
    ) delivery ON TRUE
    LEFT JOIN LATERAL (
      SELECT ml."status", ml."retryCount"
      FROM "MessageLog" ml
      WHERE ml."reservationId" = dc."reservationId"
        AND ml."communicationType" =
          'PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE'
        AND ml."channel" = 'email'
      ORDER BY ml."createdAt" DESC, ml."id" DESC
      LIMIT 1
    ) closure_delivery ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS "recipientCount",
        COUNT(*) FILTER (
          WHERE host_message."status" = 'SENT'
        )::int AS "sentCount",
        COUNT(*) FILTER (
          WHERE host_message."status" = 'FAILED'
            AND host_message."retryCount" < ${boundedMaxMessageRetries}
        )::int AS "retryingCount",
        COUNT(*) FILTER (
          WHERE host_message."status" = 'FAILED_FINAL'
            OR (
              host_message."status" = 'FAILED'
              AND host_message."retryCount" >= ${boundedMaxMessageRetries}
            )
            OR (
              host_message."id" IS NOT NULL
              AND (
                host_message."status" IS NULL
                OR host_message."status" NOT IN (
                  'SENT',
                  'FAILED',
                  'FAILED_FINAL'
                )
              )
            )
        )::int AS "failedFinalCount",
        COUNT(*) FILTER (
          WHERE host_message."id" IS NULL
        )::int AS "missingCount"
      FROM (
        SELECT DISTINCT
          LOWER(BTRIM(candidate."email")) AS "email"
        FROM "DashboardUser" candidate
        WHERE candidate."organizationId" = property."organizationId"
          AND candidate."isActive" = true
          AND candidate."role" = 'ORG_ADMIN'
          AND BTRIM(candidate."email") <> ''
      ) dashboard_user
      LEFT JOIN LATERAL (
        SELECT ml."id", ml."status", ml."retryCount"
        FROM "MessageLog" ml
        WHERE ml."reservationId" = dc."reservationId"
          AND ml."communicationType" =
            'PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE'
          AND ml."channel" = 'email'
          AND ml."organizationId" = property."organizationId"
          AND ml."propertyId" = property."id"
          AND LOWER(BTRIM(ml."to")) = dashboard_user."email"
        ORDER BY ml."createdAt" DESC, ml."id" DESC
        LIMIT 1
      ) host_message ON TRUE
    ) host_delivery ON TRUE
    WHERE oi."id" IS NULL
      OR oi."lastSignalAt" < dc."updatedAt"
      OR oi."metadata" ->> 'damageCaseStatus'
        IS DISTINCT FROM dc."status"::text
      OR oi."metadata" ->> 'guestResponse'
        IS DISTINCT FROM dc."guestResponse"::text
      OR oi."organizationId"
        IS DISTINCT FROM property."organizationId"
      OR oi."propertyId"
        IS DISTINCT FROM property."id"
      OR oi."reservationId"
        IS DISTINCT FROM reservation."id"
      OR oi."metadata" ->> 'damageNoticeDeliveryStatus'
        IS DISTINCT FROM delivery."status"
      OR oi."metadata" ->> 'damageNoticeRetryCount'
        IS DISTINCT FROM delivery."retryCount"::text
      OR oi."metadata" ->> 'closureNoticeRequired'
        IS DISTINCT FROM (dc."guestNotifiedAt" IS NOT NULL)::text
      OR oi."metadata" ->> 'closureNoticeDeliveryStatus'
        IS DISTINCT FROM closure_delivery."status"
      OR oi."metadata" ->> 'closureNoticeRetryCount'
        IS DISTINCT FROM closure_delivery."retryCount"::text
      OR oi."metadata" ->> 'hostResponseDeliveryStatus'
        IS DISTINCT FROM CASE
          WHEN dc."guestResponse" NOT IN ('ACCEPTED', 'DISPUTED')
            THEN 'NOT_REQUIRED'
          WHEN host_delivery."recipientCount" = 0
            THEN 'DESTINATION_MISSING'
          WHEN host_delivery."failedFinalCount" > 0
            THEN 'FAILED_FINAL'
          WHEN host_delivery."missingCount" > 0
            THEN 'MISSING'
          WHEN host_delivery."retryingCount" > 0
            THEN 'RETRYING'
          ELSE 'SENT'
        END
      OR oi."metadata" ->> 'hostResponseRecipientCount'
        IS DISTINCT FROM CASE
          WHEN dc."guestResponse" IN ('ACCEPTED', 'DISPUTED')
            THEN host_delivery."recipientCount"::text
          ELSE '0'
        END
      OR oi."metadata" ->> 'hostResponseSentCount'
        IS DISTINCT FROM CASE
          WHEN dc."guestResponse" IN ('ACCEPTED', 'DISPUTED')
            THEN host_delivery."sentCount"::text
          ELSE '0'
        END
      OR oi."metadata" ->> 'hostResponseRetryingCount'
        IS DISTINCT FROM CASE
          WHEN dc."guestResponse" IN ('ACCEPTED', 'DISPUTED')
            THEN host_delivery."retryingCount"::text
          ELSE '0'
        END
      OR oi."metadata" ->> 'hostResponseFailedFinalCount'
        IS DISTINCT FROM CASE
          WHEN dc."guestResponse" IN ('ACCEPTED', 'DISPUTED')
            THEN host_delivery."failedFinalCount"::text
          ELSE '0'
        END
      OR oi."metadata" ->> 'hostResponseMissingCount'
        IS DISTINCT FROM CASE
          WHEN dc."guestResponse" IN ('ACCEPTED', 'DISPUTED')
            THEN host_delivery."missingCount"::text
          ELSE '0'
        END
    ORDER BY dc."updatedAt" ASC, dc."id" ASC
    LIMIT ${boundedBatchSize}
  `);
}

export async function reconcileDamageCaseMissionControl(input: {
  prisma: PrismaClient;
  batchSize: number;
  maxMessageRetries?: number;
  findCandidates?: CandidateFinder;
  syncDamageCase?: DamageCaseSync;
}) {
  const findCandidates =
    input.findCandidates ??
    findDamageCaseMissionControlReconciliationCandidates;
  const syncDamageCase =
    input.syncDamageCase ?? syncDamageCaseMissionControlSafely;
  const maxMessageRetries =
    resolveDamageCaseMaxMessageRetries(
      input.maxMessageRetries ?? process.env.MESSAGE_MAX_RETRIES
    );
  const candidates = await findCandidates(
    input.prisma,
    input.batchSize,
    maxMessageRetries
  );
  let reconciled = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const result = await syncDamageCase({
      prisma: input.prisma,
      damageCaseId: candidate.damageCaseId,
      maxMessageRetries,
    });

    if (result.ok) {
      reconciled += 1;
    } else {
      failed += 1;
    }
  }

  return {
    checked: candidates.length,
    reconciled,
    failed,
  };
}
