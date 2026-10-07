import type { PrismaClient } from "@prisma/client";
import { prepareCleanerAccessExtensionInTransaction } from "./cleaner-access-extension-plan.service.js";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card.js";

/** A durable single-attempt command. An ambiguous remote result requires review,
 * never an automatic repeat or an optimistic local access receipt. */
export async function extendCleanerAccess(db: PrismaClient, scope: { reportId: string; organizationId: string },
  dependencies = { changeCardPeriod: ttlockChangeCardPeriod, now: () => new Date() }) {
  const intent = await db.$transaction(async tx => {
    const previous = await tx.cleaningAccessExtension.findUnique({ where: { reportId: scope.reportId } });
    if (previous) {
      if (previous.organizationId !== scope.organizationId) throw new Error("CLEANER_EXTENSION_SCOPE_INVALID");
      return previous;
    }
    const plan = await prepareCleanerAccessExtensionInTransaction(tx, scope, dependencies.now());
    return tx.cleaningAccessExtension.create({ data: {
      reportId: plan.reportId, organizationId: plan.organizationId, propertyId: plan.propertyId,
      reservationId: plan.reservationId, cleaningWorkId: plan.cleaningWorkId,
      confirmationId: plan.confirmationId!, nfcAssignmentId: plan.nfcAssignmentId, nfcCardId: plan.nfcCardId,
      ttlockLockId: plan.lockId, ttlockCardId: plan.cardId, policyRevision: plan.policyRevision!,
      startsAt: plan.startsAt, previousEndsAt: plan.previousEndsAt, proposedEndsAt: plan.proposedEndsAt,
    } });
  });
  if (intent.state === "SENDING" && intent.updatedAt.getTime() < dependencies.now().getTime() - 60_000) {
    await db.$transaction(async tx => {
      const stale = await tx.cleaningAccessExtension.updateMany({ where: { id: intent.id, state: "SENDING", updatedAt: intent.updatedAt },
        data: { state: "UNCERTAIN", lastError: "CLEANER_EXTENSION_INTERRUPTED" } });
      if (stale.count) await tx.nfcAssignment.updateMany({ where: { id: intent.nfcAssignmentId, status: "PROVISIONING", lastError: "CLEANER_EXTENSION_PENDING" },
        data: { lastError: "CLEANER_EXTENSION_UNCERTAIN" } });
    });
    const current = await db.cleaningAccessExtension.findUniqueOrThrow({ where: { id: intent.id } });
    return { state: current.state, replayed: true, accessChanged: current.state === "APPLIED" };
  }
  if (intent.state !== "PREPARED") return { state: intent.state, replayed: true, accessChanged: intent.state === "APPLIED" };
  const claimed = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${intent.reservationId} FOR UPDATE`;
    const claim = await tx.cleaningAccessExtension.updateMany({ where: { id: intent.id, state: "PREPARED" }, data: { state: "SENDING" } });
    if (!claim.count) return false;
    const grant = await tx.nfcAssignment.updateMany({ where: { id: intent.nfcAssignmentId, status: "ACTIVE", endsAt: intent.previousEndsAt },
      data: { status: "PROVISIONING", provisioningStartedAt: dependencies.now(), lastError: "CLEANER_EXTENSION_PENDING" } });
    if (grant.count !== 1) throw new Error("CLEANER_EXTENSION_CLAIM_LOST");
    return true;
  });
  if (!claimed) return { state: "SENDING", replayed: true, accessChanged: false };
  let providerAttempted = false;
  try {
    await db.$transaction(async tx => {
      // Card lock serializes against expiry. Reservation lock protects work and
      // consent; property lock serializes with host recovery-limit edits.
      await tx.$queryRaw`SELECT "id" FROM "Property" WHERE "id" = ${intent.propertyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${intent.reservationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "NfcAssignment" WHERE "id" = ${intent.nfcAssignmentId} FOR UPDATE`;
      const plan = await prepareCleanerAccessExtensionInTransaction(tx, scope, dependencies.now(), intent.nfcAssignmentId);
      if (plan.nfcAssignmentId !== intent.nfcAssignmentId || plan.lockId !== intent.ttlockLockId || plan.cardId !== intent.ttlockCardId ||
          plan.policyRevision !== intent.policyRevision || plan.proposedEndsAt.getTime() !== intent.proposedEndsAt.getTime() ||
          plan.previousEndsAt.getTime() !== intent.previousEndsAt.getTime()) throw new Error("CLEANER_EXTENSION_CONTEXT_CHANGED");
      const assignment = await tx.staffAssignment.findFirst({ where: { reservationId: intent.reservationId,
        staffMemberId: (await tx.cleaningWork.findUniqueOrThrow({ where: { id: intent.cleaningWorkId } })).staffMemberId,
        method: "NFC_TIMEBOUND", status: { in: ["SCHEDULED", "ACTIVE"] }, startsAt: intent.startsAt, endsAt: intent.previousEndsAt } });
      if (!assignment) throw new Error("CLEANER_EXTENSION_STAFF_ACCESS_CHANGED");
      providerAttempted = true;
      await dependencies.changeCardPeriod({ lockId: intent.ttlockLockId, cardId: intent.ttlockCardId,
        startDate: intent.startsAt.getTime(), endDate: intent.proposedEndsAt.getTime(), changeType: 2, timeoutMs: 20_000 });
      // Re-read occupancy after the remote response. A concurrently committed
      // arrival must not become a locally certified extension.
      const departure = await tx.reservation.findUniqueOrThrow({ where: { id: intent.reservationId }, select: { checkOut: true } });
      if (await tx.reservation.findFirst({ where: { propertyId: intent.propertyId, id: { not: intent.reservationId },
        status: { not: "CANCELLED" }, checkOut: { gt: departure.checkOut } }, select: { id: true } })) throw new Error("CLEANER_EXTENSION_ARRIVAL_CHANGED_AFTER_COMMAND");
      const prior = await tx.cleanerNfcProgrammingAttempt.findFirst({ where: { nfcAssignmentId: intent.nfcAssignmentId }, orderBy: { attemptNumber: "desc" } });
      await tx.cleanerNfcProgrammingAttempt.create({ data: { nfcAssignmentId: intent.nfcAssignmentId,
        confirmationId: intent.confirmationId, attemptNumber: (prior?.attemptNumber ?? 0) + 1,
        organizationId: intent.organizationId, ttlockLockId: intent.ttlockLockId, ttlockCardId: intent.ttlockCardId,
        startsAt: intent.startsAt, endsAt: intent.proposedEndsAt, state: "ACKNOWLEDGED", acknowledgedAt: dependencies.now() } });
      await tx.nfcAssignment.update({ where: { id: intent.nfcAssignmentId }, data: { status: "ACTIVE", endsAt: intent.proposedEndsAt,
        retryCount: { increment: 1 }, provisioningStartedAt: null, lastError: null } });
      await tx.staffAssignment.update({ where: { id: assignment.id }, data: { endsAt: intent.proposedEndsAt } });
      if (assignment.accessGrantId) await tx.accessGrant.updateMany({ where: { id: assignment.accessGrantId,
        type: "STAFF", staffMemberId: assignment.staffMemberId, reservationId: intent.reservationId }, data: { endsAt: intent.proposedEndsAt } });
      await tx.cleaningAccessExtension.update({ where: { id: intent.id }, data: { state: "APPLIED", acknowledgedAt: dependencies.now() } });
    }, { maxWait: 5_000, timeout: 30_000 });
    return { state: "APPLIED", replayed: false, accessChanged: true };
  } catch (error) {
    const state = providerAttempted ? "UNCERTAIN" : "ABORTED";
    await db.$transaction(async tx => {
      await tx.cleaningAccessExtension.updateMany({ where: { id: intent.id, state: "SENDING" },
        data: { state, lastError: error instanceof Error ? error.message : String(error) } });
      await tx.nfcAssignment.updateMany({ where: { id: intent.nfcAssignmentId, status: "PROVISIONING", lastError: "CLEANER_EXTENSION_PENDING" },
        data: providerAttempted ? { lastError: "CLEANER_EXTENSION_UNCERTAIN" } : { status: "ACTIVE", provisioningStartedAt: null, lastError: null } });
    });
    return { state, replayed: false, accessChanged: false };
  }
}
