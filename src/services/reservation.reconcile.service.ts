import {
  PrismaClient,
  AccessStatus,
  ReservationStatus,
  AccessGrantType,
  NfcAssignmentStatus,
  NfcAssignmentRole,
} from "@prisma/client";

import { deactivateGrant } from "../services/ttlock/ttlock.brain";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";
import { log } from "../utils/log";

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

  const reservationDatesChanged =
    !prevIn ||
    !prevOut ||
    prevIn.getTime() !== desiredStart.getTime() ||
    prevOut.getTime() !== desiredEnd.getTime();
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
      const cleaningStartsAt = new Date(desiredEnd.getTime() + 30 * 60 * 1000);
      const cleaningEndsAt = new Date(
        cleaningStartsAt.getTime() + 3 * 60 * 60 * 1000
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
    reason: reservationDatesChanged || grantsNeedUpdate || nfcNeedReschedule ? "DATES_CHANGED" : "NOOP",
    grantsNeedUpdate,
    nfcNeedReschedule,
    hardwareNeedSync,
  };

  log("reconcile.plan", plan);
  
  console.log("[reconcile][plan]", plan);
  
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
  if (plan.grantsNeedUpdate) {
    for (const g of guestGrants) {
      const changed =
        g.startsAt.getTime() !== desiredStart.getTime() ||
        g.endsAt.getTime() !== desiredEnd.getTime();

      if (!changed) continue;

      await prisma.accessGrant.update({
        where: { id: g.id },
        data: { startsAt: desiredStart, endsAt: desiredEnd, lastError: null },
      });
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

    const cleaningStartsAt = new Date(desiredEnd.getTime() + 30 * 60 * 1000);
    const cleaningEndsAt = new Date(
      cleaningStartsAt.getTime() + 3 * 60 * 60 * 1000
    );

    for (const a of nfcAssignments) {
      if (
        a.status === NfcAssignmentStatus.FAILED ||
        a.status === NfcAssignmentStatus.ENDED
      )
        continue;

      const next =
        a.role === NfcAssignmentRole.CLEANING
          ? { startsAt: cleaningStartsAt, endsAt: cleaningEndsAt }
          : { startsAt: a.startsAt, endsAt: desiredEnd };

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