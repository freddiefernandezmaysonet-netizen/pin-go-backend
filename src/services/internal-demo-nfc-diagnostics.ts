import type { PrismaClient } from "@prisma/client";

// Read only, called after Demo Center's platform-admin and property/org checks.
// Return error categories/provider codes, never raw errors or access credentials.
export async function readDemoGuestNfcDiagnostics(db: Pick<PrismaClient, "nfcCard">, propertyId: string) {
  const cards = await db.nfcCard.findMany({
    where: { propertyId, label: { startsWith: "Guest-", mode: "insensitive" }, ttlockCardId: { gt: 0 } },
    orderBy: { label: "asc" }, take: 20,
    select: { label: true, status: true, NfcAssignment: {
      where: { status: { in: ["ACTIVE", "SCHEDULED", "PROVISIONING", "FAILED"] } },
      orderBy: { updatedAt: "desc" }, take: 5,
      select: { status: true, startsAt: true, endsAt: true, lastError: true,
        Reservation: { select: { reservationNumber: true, status: true, checkOut: true } } },
    } },
  });
  return cards.map(card => ({
    label: card.label, status: card.status,
    assignments: card.NfcAssignment.map(assignment => ({
      status: assignment.status, startsAt: assignment.startsAt, endsAt: assignment.endsAt,
      reservationNumber: assignment.Reservation.reservationNumber,
      reservationStatus: assignment.Reservation.status, checkOut: assignment.Reservation.checkOut,
      errorCategory: assignment.lastError?.match(/^([A-Z][A-Z0-9_]{1,100})(?=:|$)/)?.[1] ??
        (assignment.lastError ? "NFC_OPERATION_FAILED" : null),
      providerCode: assignment.lastError?.match(/\bTTLock errcode=(-?\d+)\b/)?.[1] ?? null,
    })),
  }));
}
