import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ReviewPolicyError } from "./review-policy.js";

export async function buildReviewModerationEvidence(reviewId: string, now = new Date()) {
  const review = await prisma.propertyReview.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      reservation: {
        select: {
          id: true,
          reservationNumber: true,
          source: true,
          externalProvider: true,
          status: true,
          paymentState: true,
          amountCollected: true,
          amountRefunded: true,
          checkIn: true,
          checkOut: true,
          createdAt: true,
          guestJourney: { select: { id: true, currentState: true, stateChangedAt: true, completedAt: true, cancelledAt: true } },
          accessGrants: { select: { id: true, method: true, status: true, startsAt: true, endsAt: true, createdAt: true, lastAppliedAt: true, revokedReason: true, lastError: true } },
        },
      },
    },
  });
  if (!review) throw new ReviewPolicyError("REVIEW_NOT_FOUND", "Review not found.", 404);
  const reservationId = review.reservation.id;
  const [messageRows, auditRows] = await prisma.$transaction([
    prisma.messageLog.findMany({
      where: { reservationId },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { id: true, channel: true, communicationType: true, status: true, provider: true, providerMessageId: true, createdAt: true, error: true },
    }),
    prisma.apmsAuditEntry.findMany({
      where: { reservationId },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { id: true, engine: true, eventType: true, status: true, severity: true, summary: true, createdAt: true },
    }),
  ]);
  const messages = messageRows.reverse();
  const audits = auditRows.reverse();
  const referenceIds = [
    reservationId,
    ...(review.reservation.guestJourney ? [review.reservation.guestJourney.id] : []),
    ...review.reservation.accessGrants.map((grant) => grant.id),
    ...messages.map((message) => message.id),
    ...audits.map((audit) => audit.id),
  ];
  return {
    kind: "PIN_GO_REVIEW_MODERATION_EVIDENCE",
    version: "reviews_e1_evidence_v1",
    generatedAt: now.toISOString(),
    referenceIds,
    reservation: {
      id: reservationId,
      reservationNumber: review.reservation.reservationNumber,
      source: review.reservation.source,
      externalProvider: review.reservation.externalProvider,
      status: review.reservation.status,
      paymentState: review.reservation.paymentState,
      amountCollected: String(review.reservation.amountCollected),
      amountRefunded: String(review.reservation.amountRefunded),
      checkIn: review.reservation.checkIn.toISOString(),
      checkOut: review.reservation.checkOut.toISOString(),
      createdAt: review.reservation.createdAt.toISOString(),
    },
    guestJourney: review.reservation.guestJourney,
    access: review.reservation.accessGrants,
    communications: messages,
    apmsAudit: audits,
    coverage: {
      communicationsLimited: messages.length === 500,
      apmsAuditLimited: audits.length === 500,
    },
  };
}

export function assertEvidenceReference(snapshot: Awaited<ReturnType<typeof buildReviewModerationEvidence>>, reference: unknown): void {
  const normalized = String(reference ?? "").trim();
  if (!normalized || !snapshot.referenceIds.includes(normalized)) {
    throw new ReviewPolicyError("MODERATION_EVIDENCE_REFERENCE_INVALID", "The evidence reference does not exist in Pin&Go operational evidence.");
  }
}

export function buildReviewModerationDecisionEvidence(
  snapshot: Awaited<ReturnType<typeof buildReviewModerationEvidence>>,
  reference: unknown
) {
  const referenceId = String(reference ?? "").trim() || null;
  const selectedReference = !referenceId
    ? null
    : referenceId === snapshot.reservation.id
      ? { type: "RESERVATION", record: snapshot.reservation }
      : snapshot.guestJourney?.id === referenceId
        ? { type: "GUEST_JOURNEY", record: snapshot.guestJourney }
        : snapshot.access.find((record) => record.id === referenceId)
          ? { type: "ACCESS_GRANT", record: snapshot.access.find((record) => record.id === referenceId)! }
          : snapshot.communications.find((record) => record.id === referenceId)
            ? { type: "COMMUNICATION", record: snapshot.communications.find((record) => record.id === referenceId)! }
            : snapshot.apmsAudit.find((record) => record.id === referenceId)
              ? { type: "APMS_AUDIT", record: snapshot.apmsAudit.find((record) => record.id === referenceId)! }
              : null;

  return {
    kind: snapshot.kind,
    version: snapshot.version,
    generatedAt: snapshot.generatedAt,
    snapshotSha256: crypto
      .createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    coverage: snapshot.coverage,
    reservation: snapshot.reservation,
    referenceId,
    selectedReference,
  };
}
