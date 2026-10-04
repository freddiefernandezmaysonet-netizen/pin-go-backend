import type { PrismaClient } from "@prisma/client";
import { readCleanerAccessWindow } from "./cleaner-access-window.service";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";

/** Revalidate existing cleaner grants when occupancy or property timing changes.
 * No guest grants, cleaning commitment snapshots or confirmations are changed. */
export async function reconcilePropertyCleanerAccess(db: PrismaClient, propertyId: string,
  dependencies = { changeCardPeriod: ttlockChangeCardPeriod, now: () => new Date() }, excludeReservationId?: string) {
  const now = dependencies.now();
  const rows = await db.nfcAssignment.findMany({ where: {
    role: "CLEANING", status: { in: ["SCHEDULED", "ACTIVE", "PROVISIONING"] }, endsAt: { gt: now },
    Reservation: { propertyId, ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}), status: { not: "CANCELLED" } },
  }, include: { NfcCard: true, Reservation: { include: { property: { include: { locks: true } } } } } });
  const failures: string[] = [];
  let repaired = 0;
  for (const a of rows) {
    try {
      let window: Awaited<ReturnType<typeof readCleanerAccessWindow>> | null;
      try { window = await readCleanerAccessWindow(db, a.Reservation); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("CLEANER_ACCESS_")) throw error;
        window = null;
      }
      if (window && window.startsAt.getTime() === a.startsAt.getTime() && window.endsAt.getTime() === a.endsAt.getTime()) continue;
      if (a.status === "PROVISIONING") throw new Error("CLEANER_ACCESS_SYNC_IN_PROGRESS");
      const claim = await db.nfcAssignment.updateMany({ where: { id: a.id, status: a.status, updatedAt: a.updatedAt },
        data: { status: "PROVISIONING", provisioningStartedAt: now } });
      if (!claim.count) throw new Error("CLEANER_ACCESS_CHANGED_DURING_RECONCILIATION");
      try {
        if (a.status === "ACTIVE") {
          const lock = a.Reservation.property.locks.find(l => l.isActive && l.ttlockLockId);
          if (!lock?.ttlockLockId || !a.NfcCard.ttlockCardId) throw new Error("CLEANER_ACCESS_HARDWARE_TARGET_MISSING");
          await dependencies.changeCardPeriod({ lockId: Number(lock.ttlockLockId), cardId: Number(a.NfcCard.ttlockCardId),
            startDate: window?.startsAt.getTime() ?? now.getTime() - 60_000,
            endDate: window?.endsAt.getTime() ?? now.getTime() - 30_000, changeType: 2 });
        }
        await db.nfcAssignment.update({ where: { id: a.id }, data: {
          status: window ? a.status : "ENDED", provisioningStartedAt: null,
          ...(window ? { startsAt: window.startsAt, endsAt: window.endsAt } : {}),
          lastError: window ? null : "CLEANER_ACCESS_WINDOW_EMPTY",
        } });
        await db.staffAssignment.updateMany({ where: { reservationId: a.reservationId, method: "NFC_TIMEBOUND",
          status: { in: ["SCHEDULED", "ACTIVE"] } }, data: window
            ? { startsAt: window.startsAt, endsAt: window.endsAt }
            : { status: "CANCELLED", lastError: "CLEANER_ACCESS_WINDOW_EMPTY" } });
        repaired++;
        if (!window) failures.push(`${a.id}:CLEANER_ACCESS_WINDOW_EMPTY`);
      } catch (error) {
        // Do not claim a new physical period when TTLock rejected or timed out.
        await db.nfcAssignment.update({ where: { id: a.id }, data: { status: a.status,
          provisioningStartedAt: null, lastError: `CLEANER_ACCESS_RECONCILE_FAILED:${error instanceof Error ? error.message : String(error)}` } });
        throw error;
      }
    } catch (error) { failures.push(`${a.id}:${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new Error(`CLEANER_ACCESS_PROPERTY_REVIEW_REQUIRED:${failures.join(";")}`);
  return { repaired };
}
