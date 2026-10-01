import { Prisma, type PrismaClient, type Reservation, type ReservationModification } from "@prisma/client";
import { StayTimePolicyError } from "../pin-ai/actions/stay-time-policy.js";
import { isStayTimeModification } from "./stay-time-apply-validation.service.js";
import { assertStayTimePaymentEvidence, type StayTimePaymentEvidence } from "./stay-time-payment-evidence.js";
import { applyGuestReservationModification } from "./guest-reservation-modification-apply.service.js";
import { GuestReservationModificationError } from "./guest-reservation-modification.service.js";

type Snapshot = ReservationModification & { reservation: Reservation };
type Scope = { modificationId: string; checkoutSessionId: string; connectedAccountId: string };
export type StayTimeRefundRequest = {
  modificationId: string; connectedAccountId: string; chargeId: string; paymentIntentId: string;
  amountMinor: number; platformFeeMinor: number; currency: "usd"; idempotencyKey: string; existingRefundId: string | null;
  recoveryStartedAt: string;
};
export type StayTimeRefundEvidence = {
  refundId: string; connectedAccountId: string; chargeId: string; paymentIntentId: string;
  amountMinor: number; platformFeeRefundedMinor: number; currency: "usd"; status: "pending" | "succeeded" | "failed";
};
type Recovery = {
  version: "stay_time_recovery_v2"; reason: string; requestedAt: string; request: StayTimeRefundRequest;
  refund: StayTimeRefundEvidence | null;
};
export type StayTimePaymentFlowDependencies = {
  client: PrismaClient; now: () => Date; reconcile: (reservationId: string) => Promise<unknown>;
  /** Trusted, account-scoped server retrieval. No guest supplied payment objects. */
  retrievePayment: (snapshot: Snapshot) => Promise<StayTimePaymentEvidence>;
  /** Must find/retrieve the original refund before retrying creation, including
   * after provider idempotency retention expires. Never refund the base booking.
   * No default provider is installed by this internal orchestration module. */
  ensureRefund: (request: StayTimeRefundRequest) => Promise<StayTimeRefundEvidence>;
};
function reject(code: string): never { throw new StayTimePolicyError(code); }
function assertScope(m: Snapshot, scope: Scope) {
  if (m.id !== scope.modificationId || !scope.connectedAccountId || !scope.checkoutSessionId ||
      m.stripeConnectedAccountId !== scope.connectedAccountId || m.stripeCheckoutSessionId !== scope.checkoutSessionId ||
      m.requestSource !== "PIN_AI_GUEST_SERVICES" || !isStayTimeModification(m.guestConfirmation) ||
      m.financialAction !== "ADDITIONAL_PAYMENT_REQUIRED" || Number(m.additionalChargeAmount) <= 0) reject("STAY_TIME_PAYMENT_SCOPE_MISMATCH");
}
async function locked<T>(deps: StayTimePaymentFlowDependencies, scope: Scope, work: (tx: Prisma.TransactionClient, m: Snapshot) => Promise<T>) {
  const locator = await deps.client.reservationModification.findUniqueOrThrow({ where: { id: scope.modificationId }, select: { reservationId: true } });
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.client.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${locator.reservationId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "ReservationModification" WHERE "id" = ${scope.modificationId} FOR UPDATE`;
        const m = await tx.reservationModification.findUniqueOrThrow({ where: { id: scope.modificationId }, include: { reservation: true } });
        if (m.reservationId !== locator.reservationId) reject("STAY_TIME_PAYMENT_SCOPE_MISMATCH");
        assertScope(m, scope);
        return work(tx, m);
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      const conflict = error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))));
      if (!conflict || attempt >= 2) throw error;
    }
  }
}
function refundRequest(m: Snapshot, startedAt = m.cancelledAt): StayTimeRefundRequest {
  if (!startedAt || !Number.isFinite(startedAt.getTime()) || !m.stripeChargeId || !m.stripePaymentIntentId || !m.stripeConnectedAccountId || m.stripePaymentStatus !== "paid") reject("STAY_TIME_RECOVERY_EVIDENCE_REQUIRED");
  return { modificationId: m.id, connectedAccountId: m.stripeConnectedAccountId, chargeId: m.stripeChargeId,
    paymentIntentId: m.stripePaymentIntentId, amountMinor: Math.round(Number(m.additionalChargeAmount) * 100),
    platformFeeMinor: Math.round(Number(m.additionalPlatformFeeAmount) * 100), currency: "usd",
    idempotencyKey: `stay-time-recovery:${m.id}`, existingRefundId: null, recoveryStartedAt: startedAt.toISOString() };
}
function recovery(m: Snapshot): Recovery {
  const value = m.failureDetails as unknown as Recovery | null;
  if (m.status !== "CANCELLED" || !["STAY_TIME_REFUND_PENDING", "STAY_TIME_REFUNDED"].includes(m.failureCode ?? "") ||
      !value || value.version !== "stay_time_recovery_v2" || typeof value.reason !== "string" || !value.request ||
      Object.entries(refundRequest(m)).some(([key, expected]) => value.request[key as keyof StayTimeRefundRequest] !== expected)) reject("STAY_TIME_RECOVERY_CONFLICT");
  if (value.refund) assertRefund(value.request, value.refund);
  if (m.failureCode === "STAY_TIME_REFUNDED" && value.refund?.status !== "succeeded") reject("STAY_TIME_RECOVERY_CONFLICT");
  return value;
}
function assertRefund(request: StayTimeRefundRequest, result: StayTimeRefundEvidence) {
  if (!result.refundId?.trim() || result.connectedAccountId !== request.connectedAccountId || result.chargeId !== request.chargeId ||
      result.paymentIntentId !== request.paymentIntentId || result.amountMinor !== request.amountMinor || result.currency !== request.currency ||
      !["pending", "succeeded", "failed"].includes(result.status) ||
      (result.status === "succeeded" && result.platformFeeRefundedMinor !== request.platformFeeMinor)) reject("STAY_TIME_REFUND_EVIDENCE_MISMATCH");
}
async function resumeRecovery(scope: Scope, deps: StayTimePaymentFlowDependencies) {
  const saved = await locked(deps, scope, async (_tx, m) => recovery(m));
  if (saved.refund?.status === "succeeded") return { outcome: "REFUNDED" as const, actionExecuted: false as const };
  const result = await deps.ensureRefund({ ...saved.request, existingRefundId: saved.refund?.refundId ?? null });
  assertRefund(saved.request, result);
  const final = await locked(deps, scope, async (tx, m) => {
    const current = recovery(m);
    if (current.refund && current.refund.refundId !== result.refundId) reject("STAY_TIME_RECOVERY_CONFLICT");
    if (current.refund?.status === "succeeded") return current.refund;
    await tx.reservationModification.update({ where: { id: m.id }, data: {
      failureCode: result.status === "succeeded" ? "STAY_TIME_REFUNDED" : "STAY_TIME_REFUND_PENDING",
      failureDetails: { ...current, refund: result } as unknown as Prisma.InputJsonValue,
    } });
    return result;
  });
  return { outcome: final.status === "succeeded" ? "REFUNDED" as const : "REFUND_PENDING" as const, actionExecuted: false as const };
}

/** Internal post-payment path; no route, webhook or worker registration. Provider
 * I/O stays outside transactions. Paid apply and refund claim use the same locks,
 * so a committed application can never race into a recovery refund here.
 */
export async function processStayTimePayment(scope: Scope, deps: StayTimePaymentFlowDependencies) {
  let snapshot = await locked(deps, scope, async (tx, m) => {
    if (m.status === "AWAITING_PAYMENT" || m.status === "EXPIRED") return tx.reservationModification.update({ where: { id: m.id },
      data: { status: "PAYMENT_PROCESSING", ...(m.status === "EXPIRED" ? { expiredAt: m.expiredAt ?? deps.now() } : {}) }, include: { reservation: true } });
    if (!["PAYMENT_PROCESSING", "APPLYING", "APPLIED", "CANCELLED"].includes(m.status)) reject("STAY_TIME_PAYMENT_STATE_INVALID");
    return m;
  });
  if (snapshot.status === "CANCELLED") return resumeRecovery(scope, deps);
  if (snapshot.status === "APPLIED") {
    const applied = await applyGuestReservationModification({ modificationId: scope.modificationId }, deps);
    return { outcome: "APPLIED" as const, actionExecuted: true as const, applied };
  }
  const evidence = await deps.retrievePayment(snapshot);
  snapshot = await locked(deps, scope, async (tx, m) => {
    if (m.status === "APPLIED" || m.status === "CANCELLED") return m;
    if (!["PAYMENT_PROCESSING", "APPLYING"].includes(m.status)) reject("STAY_TIME_PAYMENT_STATE_INVALID");
    const refs = { stripePaymentStatus: "paid", stripePaymentIntentId: evidence.paymentIntent.id, stripeChargeId: evidence.charge.id,
      stripeApplicationFeeId: evidence.applicationFee?.id ?? null };
    for (const key of ["stripePaymentIntentId", "stripeChargeId", "stripeApplicationFeeId"] as const) {
      if (m[key] && m[key] !== refs[key]) reject("STAY_TIME_PAYMENT_EVIDENCE_MISMATCH");
    }
    assertStayTimePaymentEvidence({ ...m, ...refs }, m.reservation, evidence, deps.now());
    return tx.reservationModification.update({ where: { id: m.id }, data: { ...refs, status: "APPLYING" }, include: { reservation: true } });
  });
  if (snapshot.status === "CANCELLED") return resumeRecovery(scope, deps);
  try {
    const applied = await applyGuestReservationModification({ modificationId: scope.modificationId }, { ...deps, stayTimePaymentEvidence: evidence });
    return { outcome: "APPLIED" as const, actionExecuted: true as const, applied };
  } catch (error) {
    const permanent = (error instanceof StayTimePolicyError && error.code !== "STAY_TIME_PAYMENT_EVIDENCE_MISMATCH") ||
      (error instanceof GuestReservationModificationError && error.statusCode < 500);
    if (!permanent) throw error; // Serialization, provider and infrastructure failures remain retryable.
    const claimed = await locked(deps, scope, async (tx, m) => {
      if (m.status === "APPLIED") return false; // Reconciliation failed after commit: never refund an applied change.
      if (m.status === "CANCELLED") { recovery(m); return true; }
      if (m.status !== "APPLYING") reject("STAY_TIME_RECOVERY_CONFLICT");
      // Evidence was verified before apply. Bind recovery to those exact stored refs,
      // even if the current reservation/account has since changed.
      if (m.stripePaymentIntentId !== snapshot.stripePaymentIntentId || m.stripeChargeId !== snapshot.stripeChargeId ||
          Number(m.additionalChargeAmount) !== Number(snapshot.additionalChargeAmount) ||
          Number(m.additionalPlatformFeeAmount) !== Number(snapshot.additionalPlatformFeeAmount)) reject("STAY_TIME_RECOVERY_CONFLICT");
      const startedAt = deps.now();
      const journal: Recovery = { version: "stay_time_recovery_v2", reason: error.code,
        requestedAt: startedAt.toISOString(), request: refundRequest(m, startedAt), refund: null };
      await tx.reservationModification.update({ where: { id: m.id }, data: { status: "CANCELLED", cancelledAt: startedAt,
        failureCode: "STAY_TIME_REFUND_PENDING", failureMessage: "Paid stay-time change could not be applied; payment recovery pending.",
        failureDetails: journal as unknown as Prisma.InputJsonValue } });
      return true;
    });
    if (!claimed) throw error;
    return resumeRecovery(scope, deps);
  }
}
