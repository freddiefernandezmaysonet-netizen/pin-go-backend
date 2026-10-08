import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  CleaningWorkScope, CleaningWorkSnapshotStore, CleaningWorkSnapshotTransaction,
} from "./cleaning-work-snapshot.service.js";

const workSelect = {
  id: true, reservationId: true, propertyId: true, staffMemberId: true, confirmationId: true,
  scheduledStartAt: true, durationCommitmentMinutes: true,
  startConfirmationGraceMinutes: true, followupGraceMinutes: true,
  timingConsentVersion: true, timingConsentAcceptedAt: true,
  startConfirmedAt: true, completionConfirmedAt: true, cancelledAt: true, supersededAt: true,
} as const;

function transactionAdapter(tx: Prisma.TransactionClient): CleaningWorkSnapshotTransaction {
  return {
    async loadContext(scope: CleaningWorkScope) {
      // Lock the canonical reservation. No client-supplied identifier enters SQL as syntax.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT r."id" FROM "Reservation" r JOIN "Property" p ON p."id" = r."propertyId"
        WHERE r."id" = ${scope.reservationId} AND r."propertyId" = ${scope.propertyId}
          AND p."organizationId" = ${scope.organizationId} FOR UPDATE OF r`;
      if (locked.length !== 1) return null;
      const reservation = await tx.reservation.findFirst({
        where: { id: scope.reservationId, propertyId: scope.propertyId,
          property: { organizationId: scope.organizationId } },
        select: { status: true, checkOut: true, property: { select: {
          status: true, cleaningNfcEnabled: true, cleaningStartOffsetMinutes: true,
        } } },
      });
      const staff = await tx.staffMember.findFirst({
        where: { id: scope.staffMemberId, organizationId: scope.organizationId },
        select: { isActive: true },
      });
      const assignment = await tx.propertyStaff.findUnique({
        where: { propertyId_staffMemberId: { propertyId: scope.propertyId, staffMemberId: scope.staffMemberId } },
        select: { isActive: true, cleaningDurationCommitmentMinutes: true,
          cleaningStartConfirmationGraceMinutes: true, cleaningFollowupGraceMinutes: true },
      });
      const confirmation = await tx.cleaningConfirmation.findFirst({
        where: { id: scope.confirmationId, reservationId: scope.reservationId,
          propertyId: scope.propertyId, staffMemberId: scope.staffMemberId },
        select: { status: true, updatedAt: true },
      });
      if (!reservation || !staff || !assignment || !confirmation) return null;
      const predecessor = confirmation.status === "CONFIRMED" ? await tx.cleaningConfirmation.findFirst({
        where: { reservationId: scope.reservationId, propertyId: scope.propertyId, status: "REASSIGNED" },
        select: { id: true },
      }) : null;
      const recoveryScheduledStartAt = predecessor ? new Date(Math.max(
        reservation.checkOut.getTime() + reservation.property.cleaningStartOffsetMinutes * 60_000,
        confirmation.updatedAt.getTime(),
      )) : undefined;
      return {
        recoveryScheduledStartAt,
        reservationStatus: reservation.status, propertyStatus: reservation.property.status,
        cleaningNfcEnabled: reservation.property.cleaningNfcEnabled,
        staffActive: staff.isActive, assignmentActive: assignment.isActive,
        confirmationStatus: confirmation.status, checkOut: reservation.checkOut,
        cleaningStartOffsetMinutes: reservation.property.cleaningStartOffsetMinutes,
        durationCommitmentMinutes: assignment.cleaningDurationCommitmentMinutes,
        startConfirmationGraceMinutes: assignment.cleaningStartConfirmationGraceMinutes,
        followupGraceMinutes: assignment.cleaningFollowupGraceMinutes,
      };
    },
    findExisting(scope) {
      return tx.cleaningWork.findFirst({
        where: { reservationId: scope.reservationId, staffMemberId: scope.staffMemberId,
          propertyId: scope.propertyId, confirmationId: scope.confirmationId },
        select: workSelect,
      });
    },
    async hasOtherCurrentWork(scope) {
      return Boolean(await tx.cleaningWork.findFirst({
        // Includes the same cleaner's older confirmation: never auto-reopen it.
        where: { reservationId: scope.reservationId,
          cancelledAt: null, supersededAt: null }, select: { id: true },
      }));
    },
    create(snapshot) { return tx.cleaningWork.create({ data: snapshot, select: workSelect }); },
  };
}

/** Injected client only: constructing this adapter neither connects nor starts a worker. */
export function createCleaningWorkSnapshotStore(db: Pick<PrismaClient, "$transaction">): CleaningWorkSnapshotStore {
  return {
    async transaction<T>(run: (tx: CleaningWorkSnapshotTransaction) => Promise<T>): Promise<T> {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await db.$transaction(tx => run(transactionAdapter(tx)), {
            isolationLevel: "Serializable", maxWait: 5000, timeout: 10000,
          });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          if (attempt === 2 || (code !== "P2034" && code !== "P2002")) throw error;
        }
      }
      throw new Error("CLEANING_WORK_TRANSACTION_RETRY_EXHAUSTED");
    },
  };
}
