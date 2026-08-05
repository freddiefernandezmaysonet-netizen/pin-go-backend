// src/services/nfc-sync.service.ts
import { prisma as prismaSingleton } from "../lib/prisma";
import {
  NfcAssignmentStatus,
  NfcCardStatus,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";
import { getOrgTtlockAccessToken } from "./ttlock/ttlock.org-auth";

const PROVISION_AHEAD_MS = 2 * 60 * 60 * 1000;
const MAX_RETRY_COUNT = 5;

function toErrString(error: unknown) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function isRetryableError(error: unknown) {
  const message = toErrString(error).toLowerCase();

  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("enotfound") ||
    message.includes("eai_again") ||
    message.includes("gateway") ||
    message.includes("offline") ||
    message.includes("sync")
  );
}

export async function retryPendingNfcSync(
  db?: PrismaClient,
  now: Date = new Date()
) {
  const prisma = db ?? prismaSingleton;
  const provisionThrough = new Date(
    now.getTime() + PROVISION_AHEAD_MS
  );

const staleProvisioningBefore = new Date(
  now.getTime() - 5 * 60 * 1000
);

  const batch = await prisma.nfcAssignment.findMany({
    where: {
      endsAt: {
        gt: now,
      },
      OR: [
        {
          status: NfcAssignmentStatus.SCHEDULED,
          startsAt: {
            lte: provisionThrough,
          },
        },
       {
  status: NfcAssignmentStatus.FAILED,
  startsAt: {
    lte: provisionThrough,
  },
  lastError: {
    startsWith: "RETRYABLE:",
  },
  retryCount: {
    lt: MAX_RETRY_COUNT,
  },
},
{
  status: NfcAssignmentStatus.PROVISIONING,
  startsAt: {
    lte: provisionThrough,
  },
  retryCount: {
    lt: MAX_RETRY_COUNT,
  },
  OR: [
    {
      provisioningStartedAt: null,
    },
    {
      provisioningStartedAt: {
        lte: staleProvisioningBefore,
      },
    },
  ],
},
   ],
},

    include: {
      NfcCard: true,
      Reservation: {
        include: {
          property: true,
        },
      },
    },
    take: 20,
    orderBy: {
      startsAt: "asc",
    },
  });

  let scheduled = 0;
  let retried = 0;
  let activated = 0;
  let failed = 0;

  for (const assignment of batch) {
    const previousStatus = assignment.status;

    if (previousStatus === NfcAssignmentStatus.SCHEDULED) {
      scheduled++;
    } else {
      retried++;
    }

    const claimed = await prisma.nfcAssignment.updateMany({
      where: {
        id: assignment.id,
        status: previousStatus,
        retryCount: assignment.retryCount,
        provisioningStartedAt:
          assignment.provisioningStartedAt,
      },
      data: {
        status: NfcAssignmentStatus.PROVISIONING,
        provisioningStartedAt: now,
        retryCount: {
          increment: 1,
        },
        lastError: null,
      },
    });

    if (claimed.count === 0) {
      continue;
    }

    try {
      if (
        assignment.Reservation.status ===
        ReservationStatus.CANCELLED
      ) {
        await prisma.nfcAssignment.update({
          where: {
            id: assignment.id,
          },
          data: {
            status: NfcAssignmentStatus.ENDED,
            provisioningStartedAt: null,
            lastError: null,
          },
        });

        continue;
      }

      const overlappingAssignment =
        await prisma.nfcAssignment.findFirst({
          where: {
            id: {
              not: assignment.id,
            },
            nfcCardId: assignment.nfcCardId,
            status: {
              in: [
                NfcAssignmentStatus.SCHEDULED,
                NfcAssignmentStatus.PROVISIONING,
                NfcAssignmentStatus.ACTIVE,
              ],
            },
            startsAt: {
              lt: assignment.endsAt,
            },
            endsAt: {
              gt: assignment.startsAt,
            },
          },
          select: {
            id: true,
          },
        });

      if (overlappingAssignment) {
        throw new Error(
          `NFC_WINDOW_CONFLICT:${overlappingAssignment.id}`
        );
      }

      const propertyId =
        assignment.Reservation.propertyId;

      const lock = await prisma.lock.findFirst({
        where: {
          propertyId,
          isActive: true,
        },
        orderBy: {
          createdAt: "asc",
        },
        select: {
          ttlockLockId: true,
        },
      });
      const ttlockLockId = Number(
        lock?.ttlockLockId ?? 0
      );

      if (!ttlockLockId) {
        throw new Error(
          "ACTIVE_TTLOCK_LOCK_NOT_FOUND"
        );
      }
      if (
        assignment.NfcCard.status !==
        NfcCardStatus.ASSIGNED
      ) {
        throw new Error(
          `NFC_CARD_NOT_ASSIGNED:${assignment.NfcCard.status}`
        );
      }

      const ttlockCardId = Number(
        assignment.NfcCard.ttlockCardId
      );

      if (!ttlockCardId) {
        throw new Error(
          assignment.role === "CLEANING"
            ? "CLEANER_TTLOCK_CARD_REF_MISSING"
            : "GUEST_TTLOCK_CARD_REF_MISSING"
        );
      }

      const accessToken =
        await getOrgTtlockAccessToken(
          prisma,
          assignment.Reservation.property
            .organizationId
        );

      await ttlockChangeCardPeriod({
        lockId: ttlockLockId,
        cardId: ttlockCardId,
        startDate: assignment.startsAt.getTime(),
        endDate: assignment.endsAt.getTime(),
        changeType: 2,
        accessToken,
      });

      await prisma.$transaction([
        prisma.nfcAssignment.update({
          where: {
            id: assignment.id,
          },
          data: {
            status: NfcAssignmentStatus.ACTIVE,
            provisioningStartedAt: null,
            provisionedAt: new Date(),
            lastError: null,
          },
        }),
        prisma.nfcCard.update({
          where: {
            id: assignment.nfcCardId,
          },
          data: {
            status: NfcCardStatus.ASSIGNED,
          },
        }),
      ]);

      activated++;
    } catch (error) {
      failed++;

      const errorMessage = toErrString(error);
      const retryable = isRetryableError(error);

      await prisma.nfcAssignment.update({
        where: {
          id: assignment.id,
        },
        data: {
          status: NfcAssignmentStatus.FAILED,
          provisioningStartedAt: null,
          lastError: retryable
            ? `RETRYABLE: ${errorMessage}`
            : errorMessage,
        },
      });
    }
  }

  return {
    scheduled,
    retried,
    activated,
    failed,
  };
}