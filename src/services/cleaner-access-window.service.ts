import type { PrismaClient, Prisma } from "@prisma/client";
import { planCleanerAccessWindow } from "./cleaner-access-window.policy";

/** Read the next occupancy, including an arrival already overlapping departure. */
export async function readCleanerAccessWindow(db: Pick<PrismaClient | Prisma.TransactionClient, "reservation">,
  reservation: { id: string; propertyId: string; checkOut: Date; source?: string | null;
    property: Parameters<typeof planCleanerAccessWindow>[0]["property"] }) {
  const next = await db.reservation.findFirst({
    where: { propertyId: reservation.propertyId, id: { not: reservation.id },
      status: { not: "CANCELLED" }, checkOut: { gt: reservation.checkOut } },
    orderBy: { checkIn: "asc" }, select: { checkIn: true },
  });
  if (reservation.source === "INTERNAL_DEMO_DIRECT_BOOKING") {
    const startsAt = new Date(
      reservation.checkOut.getTime() +
        reservation.property.cleaningStartOffsetMinutes * 60_000
    );
    const desiredEndsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const endsAt = new Date(
      Math.min(desiredEndsAt.getTime(), next?.checkIn?.getTime() ?? Infinity)
    );
    if (endsAt <= startsAt) throw new Error("CLEANER_ACCESS_WINDOW_EMPTY");
    return includeAppliedCleanerExtension(db, reservation.id, reservation.propertyId, { startsAt, endsAt, durationMinutes: 30 }, Boolean(next));
  }

  const window = planCleanerAccessWindow({ checkOut: reservation.checkOut, property: reservation.property,
    nextCheckIn: next?.checkIn ?? null });
  return includeAppliedCleanerExtension(db, reservation.id, reservation.propertyId, window, Boolean(next));
}

async function includeAppliedCleanerExtension(db: Pick<PrismaClient | Prisma.TransactionClient, "reservation">,
  reservationId: string, propertyId: string, window: { startsAt: Date; endsAt: Date; durationMinutes: number }, hasNext: boolean) {
  // Optional only for the existing narrow read adapters; real Prisma clients
  // supply both delegates. Any database error fails the read rather than hiding it.
  const source = db as Partial<Prisma.TransactionClient>;
  if (hasNext || !source.cleaningAccessExtension || !source.cleaningRecoveryPolicy || !source.cleaningConfirmation) return window;
  const current = await source.cleaningConfirmation.findMany({ where: { reservationId, propertyId, status: { in: ["PENDING", "CONFIRMED"] } }, take: 2 });
  const confirmation = current[0];
  if (current.length !== 1 || !confirmation || confirmation.status !== "CONFIRMED") return window;
  const [extension, policy] = await Promise.all([
    source.cleaningAccessExtension.findFirst({ where: { reservationId, propertyId, state: "APPLIED", startsAt: window.startsAt,
      confirmationId: confirmation.id, report: { work: { cancelledAt: null, supersededAt: null } } },
      orderBy: { proposedEndsAt: "desc" } }),
    source.cleaningRecoveryPolicy.findUnique({ where: { propertyId } }),
  ]);
  if (!extension || !policy) return window;
  const endsAt = new Date(Math.max(window.endsAt.getTime(), Math.min(extension.proposedEndsAt.getTime(),
    window.endsAt.getTime() + policy.maxAccessExtensionMinutes * 60_000)));
  return { ...window, endsAt };
}
