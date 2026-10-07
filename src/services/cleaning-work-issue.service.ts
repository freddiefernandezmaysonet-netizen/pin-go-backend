import type { Prisma, PrismaClient } from "@prisma/client";
import { assessLatestCleaningIssue } from "./cleaning-issue-assessment.service.js";

export class CleaningWorkIssueError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
type Identity = { confirmationId: string; staffMemberId: string; organizationId: string };
export function parseCleaningIssue(raw: any) {
  const kind = raw?.kind;
  const reason = typeof raw?.reason === "string" ? raw.reason.trim() : "";
  if (!["DELAY", "MORE_TIME", "INCOMPLETE"].includes(kind) || !reason || reason.length > 1000 ||
      typeof raw?.requestId !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(raw.requestId)) {
    throw new CleaningWorkIssueError("CLEANING_ISSUE_INVALID", 400);
  }
  let estimatedAt: Date | null = null;
  if (kind !== "INCOMPLETE") {
    if (typeof raw.estimatedAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(raw.estimatedAt)) throw new CleaningWorkIssueError("CLEANING_ESTIMATE_INVALID", 400);
    estimatedAt = new Date(raw.estimatedAt);
    if (!Number.isFinite(estimatedAt.getTime())) throw new CleaningWorkIssueError("CLEANING_ESTIMATE_INVALID", 400);
  } else if (raw.estimatedAt != null) throw new CleaningWorkIssueError("CLEANING_ESTIMATE_INVALID", 400);
  return { kind: kind as "DELAY" | "MORE_TIME" | "INCOMPLETE", reason, requestId: raw.requestId as string, estimatedAt };
}
async function currentWork(tx: Prisma.TransactionClient, identity: Identity) {
  const offer = await tx.cleaningConfirmation.findFirst({ where: { id: identity.confirmationId, staffMemberId: identity.staffMemberId } });
  if (!offer) throw new CleaningWorkIssueError("CLEANING_NOT_AVAILABLE", 404);
  await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${offer.reservationId} FOR UPDATE`;
  const reservation = await tx.reservation.findFirst({ where: { id: offer.reservationId, propertyId: offer.propertyId, status: "ACTIVE", property: { organizationId: identity.organizationId, status: "ACTIVE" } } });
  const staff = await tx.staffMember.findFirst({ where: { id: identity.staffMemberId, organizationId: identity.organizationId, isActive: true } });
  const offers = await tx.cleaningConfirmation.findMany({ where: { reservationId: offer.reservationId, propertyId: offer.propertyId, status: "CONFIRMED" }, take: 2 });
  if (!reservation || !staff || offers.length !== 1 || offers[0].id !== offer.id) throw new CleaningWorkIssueError("CLEANING_NOT_AVAILABLE", 404);
  const works = await tx.cleaningWork.findMany({ where: { confirmationId: offer.id, reservationId: offer.reservationId, propertyId: offer.propertyId, staffMemberId: identity.staffMemberId }, take: 2 });
  const work = works[0];
  if (works.length !== 1 || work.cancelledAt || work.supersededAt || work.completionConfirmedAt) throw new CleaningWorkIssueError("CLEANING_WORK_CLOSED");
  return work;
}
/** Records a declaration only: no recovery, access, assignment or completion writes. */
export async function reportCleaningIssue(db: PrismaClient, identity: Identity, raw: unknown, now = new Date()) {
  const report = parseCleaningIssue(raw);
  return db.$transaction(async tx => {
    const work = await currentWork(tx, identity);
    const previous = await tx.cleaningWorkIssueReport.findUnique({ where: { cleaningWorkId_requestId: { cleaningWorkId: work.id, requestId: report.requestId } } });
    if (previous) {
      if (previous.kind !== report.kind || previous.reason !== report.reason || previous.estimatedAt?.getTime() !== report.estimatedAt?.getTime()) throw new CleaningWorkIssueError("CLEANING_REPORT_CONFLICT");
      return { report: previous, recoveryStatus: "RECORDED" as const };
    }
    if ((report.kind === "DELAY" && work.startConfirmedAt) || (report.kind !== "DELAY" && !work.startConfirmedAt)) throw new CleaningWorkIssueError("CLEANING_REPORT_PHASE_INVALID");
    if (report.estimatedAt && (report.estimatedAt <= now || report.estimatedAt.getTime() > now.getTime() + 24 * 60 * 60 * 1000)) throw new CleaningWorkIssueError("CLEANING_ESTIMATE_INVALID", 400);
    const saved = await tx.cleaningWorkIssueReport.create({ data: { ...report, cleaningWorkId: work.id, reportedAt: now } });
    return { report: saved, recoveryStatus: "RECORDED" as const };
  });
}
export async function readCleaningIssues(db: PrismaClient, identity: Identity, now = new Date()) {
  return db.$transaction(async tx => {
    const work = await currentWork(tx, identity);
    const reports = await tx.cleaningWorkIssueReport.findMany({ where: { cleaningWorkId: work.id }, orderBy: [{ reportedAt: "desc" }, { id: "desc" }], take: 20 });
    const assessment = await assessLatestCleaningIssue(tx, work, now);
    return { reports, assessment, recoveryStatus: "RECORDED" as const };
  });
}
