import type { PrismaClient } from "@prisma/client";
import type { Scope, Thread } from "./host-inbox.js";

export async function attachInboxReservations(prisma: Pick<PrismaClient, "reservation">, scope: Scope, threads: Thread[]) {
  const bookingIds = [...new Set(threads.flatMap(t => t.bookingId ? [t.bookingId] : []))];
  const rows = bookingIds.length ? await prisma.reservation.findMany({ where: {
    propertyId: scope.propertyId, externalProvider: "CHANNEX", externalId: { in: bookingIds },
    property: { organizationId: scope.organizationId },
  }, select: { externalId: true, reservationNumber: true } }) : [];
  return threads.map(thread => {
    const matches = rows.filter(r => r.externalId === thread.bookingId);
    return { ...thread, reservationNumber: thread.bookingId && matches.length === 1 ? matches[0]!.reservationNumber : null };
  });
}
