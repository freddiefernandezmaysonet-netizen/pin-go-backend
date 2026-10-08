import type { Prisma, PrismaClient } from "@prisma/client";
import { assessLatestCleaningIssue } from "./cleaning-issue-assessment.service.js";

import { cleaningPinAIRecoveryAllowed } from "./cleaning-pin-ai-activation.service.js";

export class CleanerAccessExtensionPlanError extends Error {
  constructor(public code: string) { super(code); }
}
const reject = (code: string): never => { throw new CleanerAccessExtensionPlanError(code); };

/** Internal read-only command preparation, not a permission to call TTLock.
 * Execution must claim a durable intent, revalidate this snapshot and coordinate
 * programming, expiry and occupancy reconciliation before sending a command.
 */
export async function prepareCleanerAccessExtension(db: PrismaClient, scope: { reportId: string; organizationId: string }, now = new Date()) {
  return db.$transaction(tx => prepareCleanerAccessExtensionInTransaction(tx, scope, now));
}
export async function prepareCleanerAccessExtensionInTransaction(tx: Prisma.TransactionClient,
  scope: { reportId: string; organizationId: string }, now = new Date(), claimedGrantId?: string) {
    const preview = await tx.cleaningWorkIssueReport.findUnique({ where: { id: scope.reportId }, include: { work: true } });
    if (!preview) return reject("CLEANER_EXTENSION_REPORT_NOT_FOUND");
    await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${preview.work.reservationId} FOR UPDATE`;
    const report = await tx.cleaningWorkIssueReport.findUnique({ where: { id: scope.reportId }, include: { work: true } });
    if (!report || report.work.reservationId !== preview.work.reservationId) return reject("CLEANER_EXTENSION_CONTEXT_CHANGED");
    const work = report.work;
    if (work.cancelledAt || work.supersededAt || work.completionConfirmedAt || !work.startConfirmedAt || report.kind !== "MORE_TIME") return reject("CLEANER_EXTENSION_WORK_NOT_ELIGIBLE");
    const reservation = await tx.reservation.findFirst({ where: { id: work.reservationId, propertyId: work.propertyId, status: "ACTIVE", property: { organizationId: scope.organizationId, status: "ACTIVE" } }, include: { property: true } });
    if (!reservation) return reject("CLEANER_EXTENSION_SCOPE_INVALID");
    if (!await cleaningPinAIRecoveryAllowed(tx, { propertyId: work.propertyId, organizationId: scope.organizationId }, now)) return reject("CLEANER_EXTENSION_PIN_AI_NOT_AUTHORIZED");
    const offers = await tx.cleaningConfirmation.findMany({ where: { reservationId: work.reservationId, propertyId: work.propertyId, status: { in: ["PENDING", "CONFIRMED"] } }, take: 2 });
    if (offers.length !== 1 || offers[0].id !== work.confirmationId || offers[0].status !== "CONFIRMED" || offers[0].staffMemberId !== work.staffMemberId) return reject("CLEANER_EXTENSION_ASSIGNMENT_CHANGED");
    const latest = await tx.cleaningWorkIssueReport.findFirst({ where: { cleaningWorkId: work.id }, orderBy: [{ reportedAt: "desc" }, { id: "desc" }] });
    if (latest?.id !== report.id) return reject("CLEANER_EXTENSION_REPORT_SUPERSEDED");
    const assessment = await assessLatestCleaningIssue(tx, work, now);
    if ((assessment?.decision !== "ACCESS_EXTENSION_REQUIRED" && !(claimedGrantId && assessment?.decision === "ACCESS_EXTENSION_PENDING")) || !assessment?.proposedAccessEnd) return reject("CLEANER_EXTENSION_POLICY_NOT_ELIGIBLE");
    const staff = await tx.staffMember.findFirst({ where: { id: work.staffMemberId, organizationId: scope.organizationId, isActive: true } });
    if (!staff?.ttlockCardRef) return reject("CLEANER_EXTENSION_CARD_MAPPING_MISSING");
    const cards = await tx.nfcCard.findMany({ where: { propertyId: work.propertyId, label: staff.ttlockCardRef, status: "ASSIGNED" }, take: 2 });
    if (cards.length !== 1 || !cards[0].ttlockCardId) return reject("CLEANER_EXTENSION_CARD_UNVERIFIED");
    const card = cards[0];
    const grants = await tx.nfcAssignment.findMany({ where: { reservationId: work.reservationId, nfcCardId: card.id, role: "CLEANING", status: { in: ["ACTIVE", "PROVISIONING", "SCHEDULED", "FAILED"] } }, take: 2 });
    const grant = grants[0];
    const expectedStatus = claimedGrantId === grant?.id ? "PROVISIONING" : "ACTIVE";
    const access = await tx.staffAssignment.findUnique({ where: { reservationId_staffMemberId: { reservationId: work.reservationId, staffMemberId: work.staffMemberId } }, select: { startsAt: true, endsAt: true } });
    if (grants.length !== 1 || grant.status !== expectedStatus || grant.endsAt <= now ||
        grant.startsAt.getTime() !== (access?.startsAt ?? work.scheduledStartAt).getTime() || grant.startsAt > work.scheduledStartAt ||
        !access || access.endsAt.getTime() !== grant.endsAt.getTime() || grant.endsAt >= assessment.proposedAccessEnd) return reject("CLEANER_EXTENSION_ACCESS_NOT_STABLE");
    // Use the most recent exact-target journal. Never guess a property's lock.
    const receipt = await tx.cleanerNfcProgrammingAttempt.findFirst({ where: { nfcAssignmentId: grant.id }, orderBy: { attemptNumber: "desc" } });
    if (!receipt || receipt.state !== "ACKNOWLEDGED" || !receipt.acknowledgedAt || receipt.confirmationId !== work.confirmationId || receipt.organizationId !== scope.organizationId || receipt.ttlockCardId !== card.ttlockCardId || receipt.startsAt.getTime() !== grant.startsAt.getTime() || receipt.endsAt.getTime() !== grant.endsAt.getTime()) return reject("CLEANER_EXTENSION_PROGRAMMING_EVIDENCE_UNVERIFIED");
    const lock = await tx.lock.findFirst({ where: { propertyId: work.propertyId, isActive: true, ttlockLockId: receipt.ttlockLockId } });
    if (!lock) return reject("CLEANER_EXTENSION_LOCK_UNVERIFIED");
    const conflict = await tx.nfcAssignment.findFirst({ where: { id: { not: grant.id }, nfcCardId: card.id, status: { in: ["SCHEDULED", "ACTIVE", "PROVISIONING", "FAILED"] }, startsAt: { lt: assessment.proposedAccessEnd }, endsAt: { gt: grant.startsAt } }, select: { id: true } });
    if (conflict) return reject("CLEANER_EXTENSION_CARD_PERIOD_CONFLICT");
    return { idempotencyKey: `CLEANER_ACCESS_EXTENSION:${report.id}`, reportId: report.id, cleaningWorkId: work.id,
      confirmationId: work.confirmationId, organizationId: scope.organizationId, reservationId: work.reservationId,
      propertyId: work.propertyId, nfcAssignmentId: grant.id, nfcCardId: card.id, policyRevision: assessment.policyRevision,
      lockId: receipt.ttlockLockId, cardId: receipt.ttlockCardId, startsAt: grant.startsAt,
      previousEndsAt: grant.endsAt, proposedEndsAt: assessment.proposedAccessEnd,
      physicalAccessVerified: false, actionsExecuted: false, authorizationGranted: false };
}
