import { readCleanerAccessWindow } from "./cleaner-access-window.service";
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
import { guestNfcDueWhere, guestNfcRetryable } from "./guest-nfc-recovery.policy";
import { reconcileGuestNfcRecoveryIssues } from "./guest-nfc-recovery-issue.service";

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
  now: Date = new Date(),
  options: { assignmentId?: string; guestOnly?: boolean } = {},
  dependencies = {
    changeCardPeriod: ttlockChangeCardPeriod,
    getAccessToken: getOrgTtlockAccessToken,
    reconcileIssues: reconcileGuestNfcRecoveryIssues,
  }
) {
  const prisma = db ?? prismaSingleton;
  const provisionThrough = new Date(
    now.getTime() + PROVISION_AHEAD_MS
  );

  const staleProvisioningBefore = new Date(now.getTime() - 5 * 60_000);
  // Preserve the existing scheduling rules for non-guest assignments.
  const legacyWhere = {
    role: { not: "GUEST" as const },
    endsAt: { gt: now },
    OR: [
      {
        status: NfcAssignmentStatus.SCHEDULED,
        startsAt: { lte: provisionThrough },
      },
      {
        status: NfcAssignmentStatus.FAILED,
        startsAt: { lte: provisionThrough },
        lastError: { startsWith: "RETRYABLE:" },
        retryCount: { lt: MAX_RETRY_COUNT },
      },
      {
        status: NfcAssignmentStatus.PROVISIONING,
        startsAt: { lte: provisionThrough },
        retryCount: { lt: MAX_RETRY_COUNT },
        OR: [
          { provisioningStartedAt: null },
          { provisioningStartedAt: { lte: staleProvisioningBefore } },
        ],
      },
    ],
  };
  const batch = await prisma.nfcAssignment.findMany({
    where: {
      ...(options.assignmentId ? { id: options.assignmentId } : {}),
      OR: options.guestOnly ? [guestNfcDueWhere(now)] : [guestNfcDueWhere(now), legacyWhere],
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
        updatedAt: assignment.updatedAt,
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

      // Guest recovery uses the current canonical stay window, including an
      // extension made while the original NFC assignment was FAILED.
      const cleanerWindow = assignment.role === "CLEANING"
        ? await readCleanerAccessWindow(prisma, assignment.Reservation) : null;
      const startsAt = cleanerWindow?.startsAt ?? (assignment.role === "GUEST" ? assignment.Reservation.checkIn : assignment.startsAt);
      const endsAt = cleanerWindow?.endsAt ?? (assignment.role === "GUEST" ? assignment.Reservation.checkOut : assignment.endsAt);
      if (cleanerWindow && (endsAt <= now || startsAt >= endsAt)) throw new Error("CLEANER_ACCESS_WINDOW_EXPIRED");
      if (assignment.role === "GUEST" &&
          (endsAt <= now || startsAt >= endsAt || assignment.NfcCard.status === NfcCardStatus.RETIRED)) {
        throw new Error("NFC_ACCESS_WINDOW_OR_CARD_INVALID");
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
              lt: endsAt,
            },
            endsAt: {
              gt: startsAt,
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
        await dependencies.getAccessToken(
          prisma,
          assignment.Reservation.property
            .organizationId
        );

      await dependencies.changeCardPeriod({
        lockId: ttlockLockId,
        cardId: ttlockCardId,
        startDate: startsAt.getTime(),
        endDate: endsAt.getTime(),
        changeType: 2,
        accessToken,
        ...(assignment.role === "GUEST" ? { timeoutMs: 20_000 } : {}),
      });

      await prisma.$transaction([
        prisma.nfcAssignment.update({
          where: {
            id: assignment.id,
          },
          data: {
            status: NfcAssignmentStatus.ACTIVE,
            startsAt,
            endsAt,
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
      const retryable = assignment.role === "GUEST"
        ? guestNfcRetryable(errorMessage) : isRetryableError(error);

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

  // Issue persistence is separate from the provider try/catch: a reporting
  // failure must never relabel a successfully provisioned card as FAILED.
  await dependencies.reconcileIssues(prisma, now);

  return {
    scheduled,
    retried,
    activated,
    failed,
  };
}
