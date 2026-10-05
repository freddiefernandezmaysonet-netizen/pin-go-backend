import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { isStayTimeModification } from "./stay-time-apply-validation.service.js";
import { applyGuestReservationModification } from "./guest-reservation-modification-apply.service.js";
import { processStayTimePayment, type StayTimePaymentFlowDependencies } from "./stay-time-payment-flow.service.js";
import { assertStayTimePaymentEvidence, assertStayTimeUnpaidExpiryEvidence, type StayTimeUnpaidExpiryEvidence } from "./stay-time-payment-evidence.js";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service.js";

export type StayTimeRecoveryDependencies = StayTimePaymentFlowDependencies & {
  retrieveUnpaidSession?: (m: Parameters<StayTimePaymentFlowDependencies["retrievePayment"]>[0]) => Promise<StayTimeUnpaidExpiryEvidence | null>;
};
const UNPAID_EXPIRY = "STAY_TIME_EXPIRED_UNPAID";
const MIN_AGE_MS = 60_000;
const LEASE_MS = 10 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const REVIEW_AFTER_ATTEMPTS = 6;
const ISSUE_CODE = "STAY_TIME_RECOVERY_REVIEW";

/** Caller holds the modification row lock. Only canonical terminal evidence
 * closes review; expiry/cancellation alone is not evidence of a settled payment. */
async function syncRecoveryIssue(tx: Prisma.TransactionClient, modificationId: string, now: Date) {
  const m = await tx.reservationModification.findUnique({ where: { id: modificationId },
    include: { reservation: { include: { property: { select: { organizationId: true } } } } } });
  if (!m || m.requestSource !== "PIN_AI_GUEST_SERVICES" || !isStayTimeModification(m.guestConfirmation)) return;
  const operationalKey = `${ISSUE_CODE}:${m.id}`;
  const existing = await tx.operationalIssue.findUnique({ where: { operationalKey } });
  if (existing && (existing.issueCode !== ISSUE_CODE || existing.reservationId !== m.reservationId ||
      existing.propertyId !== m.reservation.propertyId || existing.organizationId !== m.reservation.property.organizationId)) return;
  if (existing?.workflowState === "RESOLVED") return;
  const applied = m.status === "APPLIED" && m.stayTimeReconciledAt !== null;
  const refunded = m.status === "CANCELLED" && m.failureCode === "STAY_TIME_REFUNDED";
  const unpaid = m.status === "EXPIRED" && m.failureCode === UNPAID_EXPIRY;
  const resolved = applied || refunded || unpaid;
  if (resolved && !existing) return;
  const waitingNormally = m.status === "AWAITING_PAYMENT" && m.checkoutExpiresAt && m.checkoutExpiresAt > now;
  if (!resolved && (!existing && (m.stayTimeRecoveryAttempts < REVIEW_AFTER_ATTEMPTS || waitingNormally))) return;
  const summary = resolved
    ? applied ? "The change was applied and its reconciliation completed; physical access is not certified by this result."
      : unpaid ? "The provider confirmed this Checkout expired without a collectible payment; no schedule change or incremental payment occurred."
      : "The canonical recovery journal confirms the incremental payment was refunded."
    : "Repeated stay-time recovery attempts could not confirm a completed change or refund.";
  await upsertOperationalIssue(tx, {
    operationalKey, issueCode: ISSUE_CODE, engine: "Reservation",
    title: resolved ? "Stay-time recovery completed" : "Stay-time recovery requires Pin&Go review",
    issue: summary, operationalImpact: resolved ? null : "A guest schedule change, access reconciliation or incremental payment remains unresolved.",
    recommendedAction: resolved ? null : "Review the canonical modification, payment evidence and reconciliation. Do not create another charge or refund without verifying the existing receipt.",
    nextAutomaticStep: resolved ? null : "Bounded recovery continues; operator review does not authorize another payment or a physical access claim.",
    severity: resolved ? "INFO" : "CRITICAL", workflowState: resolved ? "RESOLVED" : "ACTION_REQUIRED",
    visibility: "DEVELOPER", responsibleActor: "PIN_GO", actionRequired: !resolved,
    canAutoResolve: true, autoResolveStatus: resolved ? "SUCCEEDED" : "FAILED", actionTarget: "SYSTEM",
    organizationId: m.reservation.property.organizationId, propertyId: m.reservation.propertyId, reservationId: m.reservationId,
    sourceType: "WORKER", occurredAt: now, lastSignalAt: now,
    ...(resolved ? { resolutionCode: applied ? "STAY_TIME_RECONCILED" : unpaid ? UNPAID_EXPIRY : "STAY_TIME_REFUNDED",
      resolutionSummary: summary, resolutionType: "AUTOMATIC" as const, resolvedBy: "PIN_GO" as const, resolvedAt: now } : {}),
    transitionCode: resolved ? "STAY_TIME_RECOVERY_REVIEW_RESOLVED" : "STAY_TIME_RECOVERY_REVIEW_REQUIRED",
    transitionSummary: summary, transitionedBy: "PIN_GO",
    metadata: { version: "stay_time_recovery_review_v1", modificationId: m.id,
      attempts: m.stayTimeRecoveryAttempts, modificationStatus: m.status, physicalAccessCertified: false },
  });
}

/** Repair closure after a webhook or a crash completed work outside this batch.
 * Bounded independently of payment polling; no provider calls or message sends. */
async function repairRecoveryIssues(deps: StayTimePaymentFlowDependencies, limit: number) {
  const issues = await deps.client.operationalIssue.findMany({
    where: { issueCode: ISSUE_CODE, operationalKey: { startsWith: `${ISSUE_CODE}:` }, workflowState: { not: "RESOLVED" } },
    orderBy: [{ lastSignalAt: "asc" }, { id: "asc" }], take: limit, select: { operationalKey: true },
  });
  for (const issue of issues) {
    const id = issue.operationalKey.slice(ISSUE_CODE.length + 1);
    await deps.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ReservationModification" WHERE "id" = ${id} FOR UPDATE`;
      await syncRecoveryIssue(tx, id, deps.now());
    });
  }
}

function due(now: Date): Prisma.ReservationModificationWhereInput {
  return {
    requestSource: "PIN_AI_GUEST_SERVICES",
    AND: [
      { OR: [
        { guestConfirmation: { path: ["operation"], equals: "EARLY_CHECKIN" } },
        { guestConfirmation: { path: ["operation"], equals: "LATE_CHECKOUT" } },
        { guestConfirmation: { path: ["quoteTerms", "version"], equals: "stay_time_quote_v1" } },
      ] },
      { OR: [
        { status: { in: ["PAYMENT_PROCESSING", "APPLYING"] } },
        { status: "CANCELLED", failureCode: "STAY_TIME_REFUND_PENDING" },
        { status: "APPLIED", stayTimeReconciledAt: null },
        { status: { in: ["AWAITING_PAYMENT", "EXPIRED"] }, financialAction: "ADDITIONAL_PAYMENT_REQUIRED",
          stripeConnectedAccountId: { not: null }, stripeCheckoutSessionId: { not: null },
          OR: [{ failureCode: null }, { failureCode: { not: UNPAID_EXPIRY } }] },
      ] },
      { OR: [{ stayTimeRecoveryNextAt: null }, { stayTimeRecoveryNextAt: { lte: now } }] },
      { OR: [{ stayTimeRecoveryLeaseUntil: null }, { stayTimeRecoveryLeaseUntil: { lte: now } }] },
    ],
    updatedAt: { lte: new Date(now.getTime() - MIN_AGE_MS) },
  };
}

/** Resumes persisted interrupted work and detects paid sessions when a webhook
 * was not observed. Only freshly verified expired sessions without any payment
 * attempt terminate unpaid; ambiguous sessions retain their canonical state.
 * Claims limit duplicate worker I/O; canonical
 * transactions and Stripe idempotency remain authoritative if a lease expires.
 * No provider call occurs in a database transaction. */
export async function runStayTimeRecoveryBatch(deps: StayTimeRecoveryDependencies, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("STAY_TIME_RECOVERY_LIMIT_INVALID");
  const observedAt = deps.now();
  if (!Number.isFinite(observedAt.getTime())) throw new Error("STAY_TIME_RECOVERY_CLOCK_INVALID");
  await repairRecoveryIssues(deps, limit);
  const candidates = await deps.client.reservationModification.findMany({
    where: due(observedAt), orderBy: [{ stayTimeRecoveryNextAt: { sort: "asc", nulls: "first" } }, { updatedAt: "asc" }, { id: "asc" }],
    take: limit, select: { id: true },
  });
  const results: Array<{ modificationId: string; outcome: "APPLIED" | "REFUNDED" | "EXPIRED_UNPAID" | "RETRY_SCHEDULED" | "SKIPPED" }> = [];
  for (const candidate of candidates) {
    const token = randomUUID();
    const claimedAt = deps.now();
    const claim = await deps.client.reservationModification.updateMany({
      where: { id: candidate.id, ...due(claimedAt) },
      data: { updatedAt: claimedAt, stayTimeRecoveryLeaseToken: token, stayTimeRecoveryLeaseUntil: new Date(claimedAt.getTime() + LEASE_MS),
        stayTimeRecoveryAttempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;
    let outcome: (typeof results)[number]["outcome"] = "RETRY_SCHEDULED";
    let attempts = 1;
    let unpaidEvidence: StayTimeUnpaidExpiryEvidence | null = null;
    try {
      const m = await deps.client.reservationModification.findUniqueOrThrow({ where: { id: candidate.id }, include: { reservation: true } });
      attempts = m.stayTimeRecoveryAttempts;
      if (m.stayTimeRecoveryLeaseToken !== token || m.requestSource !== "PIN_AI_GUEST_SERVICES" || !isStayTimeModification(m.guestConfirmation)) {
        outcome = "SKIPPED";
      } else if (m.status === "APPLIED" || (m.status === "APPLYING" && m.financialAction === "NO_PAYMENT_REQUIRED")) {
        if (m.status !== "APPLIED" || !m.stayTimeReconciledAt) {
          await applyGuestReservationModification({ modificationId: m.id }, deps);
        }
        outcome = "APPLIED";
      } else if (m.status === "CANCELLED" && m.failureCode === "STAY_TIME_REFUNDED") {
        outcome = "REFUNDED";
      } else if ((["AWAITING_PAYMENT", "EXPIRED", "PAYMENT_PROCESSING", "APPLYING"].includes(m.status) ||
          (m.status === "CANCELLED" && m.failureCode === "STAY_TIME_REFUND_PENDING")) &&
          m.stripeConnectedAccountId && m.stripeCheckoutSessionId) {
        if (m.status === "AWAITING_PAYMENT" || m.status === "EXPIRED") {
          // Read-only preflight before canonical processing claims the payment.
          // Never turn an unpaid/unknown session into PAYMENT_PROCESSING, which
          // would extend its availability hold. Processing retrieves again under
          // its current scope and independently validates before apply/refund.
          let evidence;
          try { evidence = await deps.retrievePayment(m); }
          catch (error) {
            if (deps.retrieveUnpaidSession && m.checkoutExpiresAt && m.checkoutExpiresAt <= deps.now()) {
              unpaidEvidence = await deps.retrieveUnpaidSession(m);
              if (unpaidEvidence) assertStayTimeUnpaidExpiryEvidence(m, m.reservation, unpaidEvidence, deps.now());
            }
            // Finalize only below, under the current database locks and lease.
            throw error;
          }
          assertStayTimePaymentEvidence({ ...m, stripePaymentStatus: "paid",
            stripePaymentIntentId: m.stripePaymentIntentId ?? evidence.paymentIntent.id,
            stripeChargeId: m.stripeChargeId ?? evidence.charge.id,
            stripeApplicationFeeId: m.stripeApplicationFeeId ?? evidence.applicationFee?.id ?? null },
          m.reservation, evidence, deps.now());
        }
        const result = await processStayTimePayment({ modificationId: m.id,
          connectedAccountId: m.stripeConnectedAccountId, checkoutSessionId: m.stripeCheckoutSessionId }, deps);
        outcome = result.outcome === "REFUND_PENDING" ? "RETRY_SCHEDULED" : result.outcome;
      }
    } catch {
      // Retain the canonical refund journal/failure evidence. Do not persist
      // raw provider errors or reset the payment's recovery/idempotency clock.
      outcome = "RETRY_SCHEDULED";
    } finally {
      const delay = Math.min(RETRY_MAX_MS, MIN_AGE_MS * 2 ** Math.min(attempts - 1, 6));
      await deps.client.$transaction(async tx => {
        if (unpaidEvidence) {
          const locator = await tx.reservationModification.findUniqueOrThrow({ where: { id: candidate.id }, select: { reservationId: true } });
          await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${locator.reservationId} FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "ReservationModification" WHERE "id" = ${candidate.id} FOR UPDATE`;
          const current = await tx.reservationModification.findUniqueOrThrow({ where: { id: candidate.id }, include: { reservation: true } });
          const now = deps.now();
          let verified = false;
          try { assertStayTimeUnpaidExpiryEvidence(current, current.reservation, unpaidEvidence, now); verified = true; } catch { /* Changed evidence retains recovery. */ }
          if (verified && current.stayTimeRecoveryLeaseToken === token && current.stayTimeRecoveryLeaseUntil && current.stayTimeRecoveryLeaseUntil > now &&
              ["AWAITING_PAYMENT", "EXPIRED"].includes(current.status) && current.requestSource === "PIN_AI_GUEST_SERVICES" &&
              isStayTimeModification(current.guestConfirmation) && !current.appliedAt && !current.cancelledAt && !current.stayTimeReconciledAt &&
              !["STAY_TIME_REFUND_PENDING", "STAY_TIME_REFUNDED"].includes(current.failureCode ?? "")) {
            await tx.reservationModification.update({ where: { id: candidate.id }, data: { status: "EXPIRED", expiredAt: current.expiredAt ?? now,
              failureCode: UNPAID_EXPIRY, failureMessage: "Checkout expired without a collectible payment; reservation unchanged.",
              failureDetails: { version: "stay_time_unpaid_expiry_v1", verifiedAt: unpaidEvidence.retrievedAt.toISOString(),
                checkoutSessionId: current.stripeCheckoutSessionId, connectedAccountId: current.stripeConnectedAccountId,
                providerExpiresAt: unpaidEvidence.session.expires_at, paymentIntentAbsent: !unpaidEvidence.canceledPaymentIntent,
                ...(unpaidEvidence.canceledPaymentIntent ? { canceledPaymentIntentId: unpaidEvidence.canceledPaymentIntent.id,
                  paymentIntentStatus: "canceled", providerCanceledAt: unpaidEvidence.canceledPaymentIntent.canceled_at,
                  amountReceived: 0, amountCapturable: 0, chargeAbsent: true } : {}) } } });
            outcome = "EXPIRED_UNPAID";
          }
        }
        const released = await tx.reservationModification.updateMany({
          where: { id: candidate.id, stayTimeRecoveryLeaseToken: token },
          data: { updatedAt: deps.now(), stayTimeRecoveryLeaseToken: null, stayTimeRecoveryLeaseUntil: null,
            stayTimeRecoveryNextAt: outcome === "RETRY_SCHEDULED" ? new Date(deps.now().getTime() + delay) : null },
        });
        // The conditional update locks the row and fences stale workers. Issue
        // persistence and lease release commit together or are both retried.
        if (released.count === 1) await syncRecoveryIssue(tx, candidate.id, deps.now());
      });
    }
    results.push({ modificationId: candidate.id, outcome });
  }
  return { observed: candidates.length, processed: results.length, results };
}
