import {
  PrismaClient,
  AccessStatus,
  ReservationStatus,
  AccessGrantType,
  NfcAssignmentStatus,
  NfcAssignmentRole,
  StaffAccessMethod,
  StaffAssignmentStatus,
} from "@prisma/client";

import { deactivateGrant } from "../services/ttlock/ttlock.brain";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";
import { log } from "../utils/log";
import { createCleaningConfirmation } from "./cleaning-confirmation.service";
import {
  dispatchPendingCleaningConfirmationForReservation,
} from "./cleaning-confirmation-dispatch.service";
import { selectNextStaffForProperty } from "./staff-selection.service";

type ChangePlan = {
  reservationId: string;
  reason: "CANCELLED" | "DATES_CHANGED" | "NOOP";
  grantsNeedUpdate: boolean;
  nfcNeedReschedule: boolean;
  hardwareNeedSync: boolean;
};

const prisma = new PrismaClient();

export async function reconcileReservation(reservationId: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      accessGrants: true,
      NfcAssignment: { include: { NfcCard: true } },
      property: { include: { locks: true } },
    },
  });

  if (!reservation) return;

  const grants = reservation.accessGrants;

  // --------------------------------------------------
  // CANCELLED → revoke everything immediately
  // --------------------------------------------------
  if (reservation.status === ReservationStatus.CANCELLED) {
    for (const grant of grants) {
      if (
        grant.status === AccessStatus.ACTIVE ||
        grant.status === AccessStatus.PENDING
      ) {
        try {
          await deactivateGrant(grant.id);
        } catch (e) {
          console.error("TTLock revoke failed", e);
        }

        await prisma.accessGrant.update({
          where: { id: grant.id },
          data: {
            status: AccessStatus.REVOKED,
            revokedReason: "CANCELLED_BY_PMS",
            lastError: null,
          },
        });
      }
    }

    // 🔥 CANCELLED → revoke NFC assignments immediately
    for (const a of reservation.NfcAssignment ?? []) {
      if (a.status !== NfcAssignmentStatus.ACTIVE) continue;

      try {
        const lock = reservation.property?.locks?.find(
          (l: any) => l.isActive && l.ttlockLockId
        );

        const ttlockLockId = lock?.ttlockLockId
          ? Number(lock.ttlockLockId)
          : null;

        if (ttlockLockId && a.NfcCard?.ttlockCardId) {
          const nowMs = Date.now();

          await ttlockChangeCardPeriod({
            lockId: ttlockLockId,
            cardId: Number(a.NfcCard.ttlockCardId),
            startDate: nowMs - 60_000,
            endDate: nowMs - 30_000,
            changeType: 2,
          });
        }

        await prisma.nfcAssignment.update({
          where: { id: a.id },
          data: {
            status: NfcAssignmentStatus.ENDED,
            lastError: null,
          },
        });
      } catch (e: any) {
        await prisma.nfcAssignment.update({
          where: { id: a.id },
          data: {
            lastError: `CANCELLED_REVOKE_FAILED: ${String(e?.message ?? e)}`,
          },
        }).catch(() => {});
      }
    }

    // opcional enterprise: marca reconciled
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { lastReconciledAt: new Date() },
    });

    return;
  }

  // --------------------------------------------------
  // ACTIVE → compute plan (diff → apply)
  // --------------------------------------------------
  const desiredStart = reservation.checkIn;
  const desiredEnd = reservation.checkOut;
  // ✅ Snapshot-based change detection (enterprise v1)
  const prevIn = reservation.lastReconciledCheckIn;
  const prevOut = reservation.lastReconciledCheckOut;

const snapshotMissing = !prevIn || !prevOut;

const reservationDatesChanged =
  !!prevIn &&
  !!prevOut &&
  (prevIn.getTime() !== desiredStart.getTime() ||
    prevOut.getTime() !== desiredEnd.getTime());

  const cleaningReconfirmationNeeded =
    reservationDatesChanged &&
    reservation.property?.cleaningNfcEnabled === true;

  const previousCleaningConfirmation = cleaningReconfirmationNeeded
    ? await prisma.cleaningConfirmation.findFirst({
        where: {
          reservationId: reservation.id,
          status: {
            in: ["PENDING", "CONFIRMED"],
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
      })
    : null;
  
  const guestGrants = grants.filter(
    (g) => g.type === AccessGrantType.GUEST && g.status !== AccessStatus.REVOKED
  );

  const grantsNeedUpdate = guestGrants.some(
    (g) =>
      g.startsAt.getTime() !== desiredStart.getTime() ||
      g.endsAt.getTime() !== desiredEnd.getTime()
  );

  const nfcAssignments = reservation.NfcAssignment ?? [];

  const nfcNeedReschedule = nfcAssignments.some((a) => {
    if (
      a.status === NfcAssignmentStatus.FAILED ||
      a.status === NfcAssignmentStatus.ENDED
    )
      return false;

    if (a.role === NfcAssignmentRole.GUEST) {
      return a.endsAt.getTime() !== desiredEnd.getTime();
    } else {
      if (reservationDatesChanged) {
        return true;
      }

       const cleaningOffsetMin =
  reservation.property?.cleaningStartOffsetMinutes ?? 30;

const cleaningDurationMin =
  reservation.property?.cleaningDurationMinutes ?? 180;

const cleaningStartsAt = new Date(
  desiredEnd.getTime() + cleaningOffsetMin * 60_000
);

const cleaningEndsAt = new Date(
  cleaningStartsAt.getTime() + cleaningDurationMin * 60_000
);     

      return (
        a.startsAt.getTime() !== cleaningStartsAt.getTime() ||
        a.endsAt.getTime() !== cleaningEndsAt.getTime()
      );
    }
  });

  const now = Date.now();
  const lastHw = reservation.lastHardwareSyncAt
    ? reservation.lastHardwareSyncAt.getTime()
    : 0;

  const hardwareDebounceMs = 10_000;
  const hardwareNeedSync =
    nfcNeedReschedule && now - lastHw > hardwareDebounceMs;

  const plan: ChangePlan = {
    reservationId: reservation.id,
    reason:
  reservationDatesChanged || grantsNeedUpdate || nfcNeedReschedule
    ? "DATES_CHANGED"
    : "NOOP",
    grantsNeedUpdate,
    nfcNeedReschedule,
    hardwareNeedSync,
  };

  log("reconcile.plan", plan);
  
  console.log("[reconcile][plan]", plan);
  
if (snapshotMissing && !grantsNeedUpdate && !nfcNeedReschedule) {
  await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      lastReconciledAt: new Date(),
      lastReconciledCheckIn: desiredStart,
      lastReconciledCheckOut: desiredEnd,
    },
  });

  return;
}

  if (plan.reason === "NOOP") {
  await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      lastReconciledAt: new Date(),
      lastReconciledCheckIn: desiredStart,
      lastReconciledCheckOut: desiredEnd,
    },
  });
  return;
}
  // 1) Apply grants updates (DB)
  if (plan.grantsNeedUpdate || reservationDatesChanged) {
    for (const g of guestGrants) {
      const changed =
        g.startsAt.getTime() !== desiredStart.getTime() ||
        g.endsAt.getTime() !== desiredEnd.getTime();

      if (!changed) continue;

     // 1. actualizar DB primero
await prisma.accessGrant.update({
  where: { id: g.id },
  data: { startsAt: desiredStart, endsAt: desiredEnd, lastError: null },
});

const passcodeLock = reservation.property?.locks?.find(
  (l: any) => l.id === g.lockId && l.ttlockLockId
);

const passcodeTtlockLockId = passcodeLock?.ttlockLockId
  ? Number(passcodeLock.ttlockLockId)
  : null;
console.log("[reconcile][passcode]", {
  reservationId: reservation.id,
  grantId: g.id,
  method: g.method,
  ttlockKeyboardPwdId: g.ttlockKeyboardPwdId,
  passcodeTtlockLockId,
  desiredStart: desiredStart.toISOString(),
  desiredEnd: desiredEnd.toISOString(),
});

if (
  reservationDatesChanged &&
  g.method === "PASSCODE_TIMEBOUND" &&
  g.ttlockKeyboardPwdId &&
  passcodeTtlockLockId
) {

  try {
   const { ttlockChangePasscode } = await import(
  "../ttlock/ttlock.passcode"
);

await ttlockChangePasscode({
  lockId: passcodeTtlockLockId,
  keyboardPwdId: Number(g.ttlockKeyboardPwdId),
  startDate: desiredStart.getTime(),
  endDate: desiredEnd.getTime(),
});    
 } catch (e: any) {
     console.error("[reconcile][passcode][FAILED]", {
    reservationId: reservation.id,
    grantId: g.id,
    error: String(e?.message ?? e),
  });       

          await prisma.accessGrant.update({
            where: { id: g.id },
            data: {
              lastError: `PASSCODE_RESYNC_FAILED: ${String(e?.message ?? e)}`,
            },
          });
        }
      }
    }
  }
    
  // 2) Apply NFC reschedule (DB + TTLock only if debounce passed)
  if (plan.nfcNeedReschedule) {
    const lock = reservation.property?.locks?.find(
      (l: any) => l.isActive && l.ttlockLockId
    );

    const ttlockLockId = lock?.ttlockLockId ? Number(lock.ttlockLockId) : null;

    if (!ttlockLockId) {
      console.log("[reconcile][nfc] no active ttlockLockId; DB-only");
    }

 const cleaningOffsetMin =
  reservation.property?.cleaningStartOffsetMinutes ?? 30;

const cleaningDurationMin =
  reservation.property?.cleaningDurationMinutes ?? 180;

const cleaningStartsAt = new Date(
  desiredEnd.getTime() + cleaningOffsetMin * 60_000
);

const cleaningEndsAt = new Date(
  cleaningStartsAt.getTime() + cleaningDurationMin * 60_000
);   

    for (const a of nfcAssignments) {
      if (
        a.status === NfcAssignmentStatus.FAILED ||
        a.status === NfcAssignmentStatus.ENDED
      )
        continue;

if (a.role === NfcAssignmentRole.CLEANING) {
  try {
    if (a.status === NfcAssignmentStatus.ACTIVE) {
      if (!ttlockLockId || !a.NfcCard?.ttlockCardId) {
        throw new Error(
          "Active cleaner NFC cannot be revoked because TTLock identifiers are missing."
        );
      }

      const nowMs = Date.now();

      await ttlockChangeCardPeriod({
        lockId: ttlockLockId,
        cardId: Number(a.NfcCard.ttlockCardId),
        startDate: nowMs - 60_000,
        endDate: nowMs - 30_000,
        changeType: 2,
      });
    }

    await prisma.nfcAssignment.update({
      where: { id: a.id },
      data: {
        status: NfcAssignmentStatus.ENDED,
        lastError: null,
      },
    });

    console.log("[reconcile][cleaning] previous NFC ended for reconfirmation", {
      reservationId: reservation.id,
      nfcAssignmentId: a.id,
    });
  } catch (e: any) {
    await prisma.nfcAssignment.update({
      where: { id: a.id },
      data: {
        lastError: `CLEANING_RECONFIRMATION_REVOKE_FAILED: ${String(
          e?.message ?? e
        )}`,
      },
    });

    throw e;
  }

  continue;
}

      const next = {
  startsAt: a.startsAt,
  endsAt: desiredEnd,
};

      const changed =
        a.startsAt.getTime() !== next.startsAt.getTime() ||
        a.endsAt.getTime() !== next.endsAt.getTime();

      if (!changed) continue;

      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { startsAt: next.startsAt, endsAt: next.endsAt, lastError: null },
      });

      if (
        plan.hardwareNeedSync &&
        ttlockLockId &&
        a.status === NfcAssignmentStatus.ACTIVE
      ) {
        try {
          await ttlockChangeCardPeriod({
            lockId: ttlockLockId,
            cardId: Number(a.NfcCard.ttlockCardId),
            startDate: next.startsAt.getTime(),
            endDate: next.endsAt.getTime(),
            changeType: 2,
          });
        } catch (e: any) {
          await prisma.nfcAssignment.update({
            where: { id: a.id },
            data: {
              lastError: `TTLOCK_CHANGE_PERIOD_FAILED: ${String(
                e?.message ?? e
              )}`,
            },
          });
        }
      }
    }

    if (plan.hardwareNeedSync) {
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { lastHardwareSyncAt: new Date() },
      });
    }
  }

  if (cleaningReconfirmationNeeded) {
    await prisma.staffAssignment.updateMany({
      where: {
        reservationId: reservation.id,
        method: StaffAccessMethod.NFC_TIMEBOUND,
        status: {
          in: [
            StaffAssignmentStatus.SCHEDULED,
            StaffAssignmentStatus.ACTIVE,
          ],
        },
      },
      data: {
        status: StaffAssignmentStatus.CANCELLED,
        lastError: null,
      },
    });

    await prisma.cleaningConfirmation.updateMany({
      where: {
        reservationId: reservation.id,
        status: {
          in: ["PENDING", "CONFIRMED"],
        },
      },
      data: {
        status: "EXPIRED",
      },
    });

    const selectedCleaner = previousCleaningConfirmation
      ? { id: previousCleaningConfirmation.staffMemberId }
      : await selectNextStaffForProperty({
          propertyId: reservation.propertyId,
        });

    if (selectedCleaner) {
      const confirmation = await createCleaningConfirmation({
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        staffMemberId: selectedCleaner.id,
      });

      try {
        const dispatchResult =
          await dispatchPendingCleaningConfirmationForReservation({
            prisma,
            reservationId: reservation.id,
          });

        console.log("[reconcile][cleaning] reconfirmation prepared", {
          reservationId: reservation.id,
          confirmationId: confirmation?.id ?? null,
          sent: dispatchResult.sent,
          skipped: dispatchResult.skipped,
          reason: dispatchResult.reason ?? null,
        });
      } catch (e: any) {
        console.error("[reconcile][cleaning] reconfirmation dispatch failed", {
          reservationId: reservation.id,
          confirmationId: confirmation?.id ?? null,
          error: String(e?.message ?? e),
        });
      }
    } else {
      console.warn("[reconcile][cleaning] reconfirmation skipped", {
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        reason: "CLEANER_NOT_FOUND",
      });
    }
  }

  // 3) Mark reconciled
  await prisma.reservation.update({
  where: { id: reservation.id },
  data: {
    lastReconciledAt: new Date(),
    lastReconciledCheckIn: desiredStart,
    lastReconciledCheckOut: desiredEnd,
    
    },
  });

}
