import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

type RenewalInput = {
  reservationId: string;
  propertyId: string;
  organizationId: string;
  checkIn: Date;
  checkOut: Date;
  expectedLastReconciledAt: Date | null;
  previousConfirmationId: string | null;
  staffMemberId: string;
  cleaningStartOffsetMinutes: number;
  cleaningDurationMinutes: number;
};

/** Called only after existing access reconciliation succeeds. No provider I/O.
 * The replacement and completed reconciliation snapshot commit together, so
 * concurrent/replayed reconcilers cannot expire a newly prepared confirmation.
 */
export async function renewCleaningConfirmation(
  db: Pick<PrismaClient, "$transaction">,
  input: RenewalInput,
  now = new Date(),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r."id" FROM "Reservation" r JOIN "Property" p ON p."id" = r."propertyId"
          WHERE r."id" = ${input.reservationId} AND r."propertyId" = ${input.propertyId}
            AND p."organizationId" = ${input.organizationId} FOR UPDATE OF r`;
        if (locked.length !== 1) throw new Error("CLEANING_RENEWAL_SCOPE_MISMATCH");
        const reservation = await tx.reservation.findUniqueOrThrow({
          where: { id: input.reservationId }, include: { property: true },
        });
        if (reservation.status !== "ACTIVE" || reservation.property.status !== "ACTIVE" ||
            !reservation.property.cleaningNfcEnabled ||
            reservation.checkIn.getTime() !== input.checkIn.getTime() ||
            reservation.checkOut.getTime() !== input.checkOut.getTime() ||
            reservation.property.cleaningStartOffsetMinutes !== input.cleaningStartOffsetMinutes ||
            reservation.property.cleaningDurationMinutes !== input.cleaningDurationMinutes) {
          throw new Error("CLEANING_RENEWAL_RESERVATION_CHANGED");
        }
        const confirmations = await tx.cleaningConfirmation.findMany({ where: {
          reservationId: input.reservationId, propertyId: input.propertyId, status: { in: ["PENDING", "CONFIRMED"] },
        }, take: 2 });
        if ((reservation.lastReconciledAt?.getTime() ?? null) !== (input.expectedLastReconciledAt?.getTime() ?? null)) {
          // A concurrent successful reconciler already committed this exact window.
          if (reservation.lastReconciledCheckIn?.getTime() === input.checkIn.getTime() &&
              reservation.lastReconciledCheckOut?.getTime() === input.checkOut.getTime()) {
            const expired = input.previousConfirmationId ? await tx.cleaningConfirmation.findFirst({ where: {
              id: input.previousConfirmationId, reservationId: input.reservationId, propertyId: input.propertyId,
              staffMemberId: input.staffMemberId, status: "EXPIRED",
            } }) : true;
            const confirmation = confirmations[0];
            if (expired && confirmations.length === 1 && confirmation && confirmation.id !== input.previousConfirmationId &&
                confirmation.staffMemberId === input.staffMemberId) {
              return { replayed: true, confirmationId: confirmation.id };
            }
            // A concurrent no-op snapshot alone is not proof of cleaning renewal.
            // Continue only through the exact old-confirmation checks below.
          } else {
            throw new Error("CLEANING_RENEWAL_STALE_RECONCILIATION");
          }
        }
        const staff = await tx.propertyStaff.findFirst({ where: {
          propertyId: input.propertyId, staffMemberId: input.staffMemberId, isActive: true,
          staffMember: { organizationId: input.organizationId, isActive: true, phoneE164: { not: null } },
        }, include: { staffMember: { select: { phoneE164: true } } } });
        if (!staff?.staffMember.phoneE164?.trim()) throw new Error("CLEANING_RENEWAL_CLEANER_UNAVAILABLE");
        if (confirmations.length > 1 ||
            (confirmations[0]?.id ?? null) !== input.previousConfirmationId ||
            (confirmations[0] && confirmations[0].staffMemberId !== input.staffMemberId)) {
          throw new Error("CLEANING_RENEWAL_CONFIRMATION_CHANGED");
        }
        const works = await tx.cleaningWork.findMany({ where: {
          reservationId: input.reservationId, cancelledAt: null, supersededAt: null,
        }, take: 2 });
        if (works.length > 1 || works.some(w => w.propertyId !== input.propertyId ||
          w.staffMemberId !== input.staffMemberId || w.confirmationId !== input.previousConfirmationId ||
          w.startConfirmedAt || w.completionConfirmedAt)) {
          throw new Error("CLEANING_RENEWAL_WORK_REQUIRES_REVIEW");
        }
        if (works[0]) {
          const closed = await tx.cleaningWork.updateMany({ where: {
            id: works[0].id, cancelledAt: null, supersededAt: null, startConfirmedAt: null, completionConfirmedAt: null,
          }, data: { supersededAt: now } });
          if (closed.count !== 1) throw new Error("CLEANING_RENEWAL_WORK_CHANGED");
        }
        await tx.staffAssignment.updateMany({ where: {
          reservationId: input.reservationId, method: "NFC_TIMEBOUND", status: { in: ["SCHEDULED", "ACTIVE"] },
        }, data: { status: "CANCELLED", lastError: null } });
        await tx.cleaningConfirmation.updateMany({ where: {
          reservationId: input.reservationId, propertyId: input.propertyId, status: { in: ["PENDING", "CONFIRMED"] },
        }, data: { status: "EXPIRED" } });
        const next = await tx.cleaningConfirmation.create({ data: {
          reservationId: input.reservationId, propertyId: input.propertyId, staffMemberId: input.staffMemberId,
          token: randomBytes(32).toString("hex"), status: "PENDING",
        } });
        await tx.reservation.update({ where: { id: input.reservationId }, data: {
          lastReconciledAt: now, lastReconciledCheckIn: input.checkIn, lastReconciledCheckOut: input.checkOut,
        } });
        return { replayed: false, confirmationId: next.id };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || (error.code === "P2010" &&
          ["40001", "40P01"].includes(String(error.meta?.code))));
      if (attempt >= 2 || !retryable) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
