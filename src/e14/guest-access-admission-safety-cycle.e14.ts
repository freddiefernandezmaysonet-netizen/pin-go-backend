import type { PrismaClient } from "@prisma/client";

import {
  evaluateGuestAccessReadiness,
} from "../services/guest-access-readiness.service.js";
import {
  recoverStaleGuestAccessProvisioningFences,
} from "./guest-access-admission-fence.service.e14.js";
import {
  shouldRunGuestAccessReadinessSafetyEvaluation,
} from "./guest-access-readiness-mission-control.policy.e14.js";
import {
  findGuestAccessMissionControlReservationIds,
  syncGuestAccessReadinessMissionControl,
} from "./guest-access-readiness-mission-control.service.e14.js";

export const GUEST_ACCESS_ADMISSION_SAFETY_INTERVAL_MS =
  60_000;

export async function runGuestAccessAdmissionSafetyCycle(
  prisma: PrismaClient,
  input: {
    now?: Date;
    limit?: number;
    e15Enabled?: boolean;
  } = {}
) {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 100;

  const recovery =
    await recoverStaleGuestAccessProvisioningFences(
      prisma,
      {
        now,
        limit,
        deferActiveSuccessToE15:
          input.e15Enabled === true,
      }
    );

  const reservationIds =
    await findGuestAccessMissionControlReservationIds(
      prisma,
      { now, limit }
    );

  let operationalIssueWrites = 0;
  let readinessEvaluations = 0;
  let failed = 0;

  for (const reservationId of reservationIds) {
    try {
      const reservation =
        await prisma.reservation.findUnique({
          where: { id: reservationId },
          select: {
            status: true,
            checkOut: true,
            guestAccessReleaseStatus: true,
            guestAccessReleaseLastError: true,
            propertyId: true,
            property: {
              select: {
                organizationId: true,
              },
            },
          },
        });

      if (
        reservation &&
        shouldRunGuestAccessReadinessSafetyEvaluation(
          {
            status: String(reservation.status),
            checkOut: reservation.checkOut,
            guestAccessReleaseStatus: String(
              reservation.guestAccessReleaseStatus
            ),
            guestAccessReleaseLastError:
              reservation.guestAccessReleaseLastError ?? null,
          },
          now
        )
      ) {
        await evaluateGuestAccessReadiness(
          prisma,
          reservationId,
          {
            persist: true,
            now,
            expectedScope: {
              organizationId:
                reservation.property.organizationId,
              propertyId:
                reservation.propertyId,
            },
          }
        );
        readinessEvaluations += 1;
      }

      const result =
        await syncGuestAccessReadinessMissionControl(
          prisma,
          reservationId,
          {
            now,
            e15Enabled: input.e15Enabled === true,
          }
        );
      operationalIssueWrites +=
        result.operationalIssueWrites;
    } catch {
      failed += 1;
    }
  }

  return {
    checkedReservations:
      reservationIds.length,
    operationalIssueWrites,
    readinessEvaluations,
    failed,
    staleFenceRecovery: recovery,
    providerExecutions: 0 as const,
    externalSideEffects: 0 as const,
  };
}
