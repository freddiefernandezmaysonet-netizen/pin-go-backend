import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { isStayTimeModification } from "./stay-time-apply-validation.service.js";
import { applyGuestReservationModification } from "./guest-reservation-modification-apply.service.js";
import { processStayTimePayment, type StayTimePaymentFlowDependencies } from "./stay-time-payment-flow.service.js";

const MIN_AGE_MS = 60_000;
const LEASE_MS = 10 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;

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
      ] },
      { OR: [{ stayTimeRecoveryNextAt: null }, { stayTimeRecoveryNextAt: { lte: now } }] },
      { OR: [{ stayTimeRecoveryLeaseUntil: null }, { stayTimeRecoveryLeaseUntil: { lte: now } }] },
    ],
    updatedAt: { lte: new Date(now.getTime() - MIN_AGE_MS) },
  };
}

/** Resumes persisted interrupted work only. Awaiting/unobserved payments still
 * require the signed webhook. Claims limit duplicate worker I/O; canonical
 * transactions and Stripe idempotency remain authoritative if a lease expires.
 * No provider call occurs in a database transaction. */
export async function runStayTimeRecoveryBatch(deps: StayTimePaymentFlowDependencies, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("STAY_TIME_RECOVERY_LIMIT_INVALID");
  const observedAt = deps.now();
  if (!Number.isFinite(observedAt.getTime())) throw new Error("STAY_TIME_RECOVERY_CLOCK_INVALID");
  const candidates = await deps.client.reservationModification.findMany({
    where: due(observedAt), orderBy: [{ stayTimeRecoveryNextAt: { sort: "asc", nulls: "first" } }, { updatedAt: "asc" }, { id: "asc" }],
    take: limit, select: { id: true },
  });
  const results: Array<{ modificationId: string; outcome: "APPLIED" | "REFUNDED" | "RETRY_SCHEDULED" | "SKIPPED" }> = [];
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
    try {
      const m = await deps.client.reservationModification.findUniqueOrThrow({ where: { id: candidate.id } });
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
      } else if ((["PAYMENT_PROCESSING", "APPLYING"].includes(m.status) ||
          (m.status === "CANCELLED" && m.failureCode === "STAY_TIME_REFUND_PENDING")) &&
          m.stripeConnectedAccountId && m.stripeCheckoutSessionId) {
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
      await deps.client.reservationModification.updateMany({
        where: { id: candidate.id, stayTimeRecoveryLeaseToken: token },
        data: { updatedAt: deps.now(), stayTimeRecoveryLeaseToken: null, stayTimeRecoveryLeaseUntil: null,
          stayTimeRecoveryNextAt: outcome === "RETRY_SCHEDULED" ? new Date(deps.now().getTime() + delay) : null },
      });
    }
    results.push({ modificationId: candidate.id, outcome });
  }
  return { observed: candidates.length, processed: results.length, results };
}
