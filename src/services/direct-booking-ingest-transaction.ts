import { Prisma, type PrismaClient, type ReservationStatus } from "@prisma/client";
import { checkPropertyAvailability } from "./availability.service";

/** Retry only the database callback. Ingest dispatch/reconciliation stays after commit. */
export async function runIngestTransaction<T>(
  db: Pick<PrismaClient, "$transaction">,
  source: string | undefined,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (source !== "DIRECT_BOOKING" && source !== "MANUAL") return db.$transaction(work);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || (error.code === "P2010" &&
          ["40001", "40P01"].includes(String(error.meta?.code))));
      if (!retryable || attempt >= 2) throw error;
    }
  }
}

export async function assertDirectBookingIngestAvailability(
  tx: Prisma.TransactionClient,
  input: { source?: string; status?: "ACTIVE" | "CANCELLED"; propertyId: string; checkIn: Date; checkOut: Date },
  previous: { id: string; checkIn: Date; checkOut: Date; status: ReservationStatus } | null,
): Promise<void> {
  if (!["DIRECT_BOOKING", "MANUAL"].includes(input.source ?? "") || input.status === "CANCELLED") return;
  // A replay of the same active stay does not acquire new occupancy.
  if (previous?.status === "ACTIVE" && previous.checkIn.getTime() === input.checkIn.getTime() &&
      previous.checkOut.getTime() === input.checkOut.getTime()) return;
  const result = await checkPropertyAvailability({
    propertyId: input.propertyId, checkIn: input.checkIn, checkOut: input.checkOut,
    ...(previous ? { excludeReservationId: previous.id } : {}),
  }, tx);
  if (!result.available) throw new Error(input.source === "MANUAL"
    ? "MANUAL_RESERVATION_DATE_CONFLICT" : "DIRECT_BOOKING_PROPERTY_NO_LONGER_AVAILABLE");
}
