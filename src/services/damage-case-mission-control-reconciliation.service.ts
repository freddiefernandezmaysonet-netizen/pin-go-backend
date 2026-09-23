import { Prisma, PrismaClient } from "@prisma/client";

import { syncDamageCaseMissionControlSafely } from "./damage-case-mission-control.service.js";

type ReconciliationCandidate = {
  damageCaseId: string;
};

type CandidateFinder = (
  prisma: PrismaClient,
  batchSize: number
) => Promise<ReconciliationCandidate[]>;

type DamageCaseSync = typeof syncDamageCaseMissionControlSafely;

export async function findDamageCaseMissionControlReconciliationCandidates(
  prisma: PrismaClient,
  batchSize: number
): Promise<ReconciliationCandidate[]> {
  const boundedBatchSize = Math.max(1, Math.min(100, Math.trunc(batchSize)));

  return prisma.$queryRaw<ReconciliationCandidate[]>(Prisma.sql`
    SELECT dc."id" AS "damageCaseId"
    FROM "DamageCase" dc
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
    WHERE oi."id" IS NULL
      OR oi."lastSignalAt" < dc."updatedAt"
      OR oi."metadata" ->> 'damageCaseStatus'
        IS DISTINCT FROM dc."status"::text
      OR oi."metadata" ->> 'guestResponse'
        IS DISTINCT FROM dc."guestResponse"::text
      OR oi."metadata" ->> 'damageNoticeDeliveryStatus'
        IS DISTINCT FROM delivery."status"
      OR oi."metadata" ->> 'damageNoticeRetryCount'
        IS DISTINCT FROM delivery."retryCount"::text
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
  const candidates = await findCandidates(input.prisma, input.batchSize);
  let reconciled = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const result = await syncDamageCase({
      prisma: input.prisma,
      damageCaseId: candidate.damageCaseId,
      maxMessageRetries: input.maxMessageRetries,
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
