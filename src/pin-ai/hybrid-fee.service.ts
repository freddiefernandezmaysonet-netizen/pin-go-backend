import { createHash, randomUUID } from "node:crypto";
import type { PinAIReservationFee, Prisma, PrismaClient } from "@prisma/client";
import { PIN_AI_HYBRID_BILLING_TERMS as TERMS, pinAIHybridBillingAllows } from "./billing-terms.js";
import type { ActivationEnvironment } from "./property-activation.js";
import type { HybridFeeProvider, ReversalRequest } from "./hybrid-fee-stripe.provider.js";
const REPLAY_MS = 23 * 60 * 60_000;
export const hybridFeeOperationKey = (reservationId: string, operation: string) =>
  `pin-ai-hybrid-v2:${createHash("sha256").update(`${reservationId}:${operation}`).digest("hex")}`;
const reversalKey = (fee: PinAIReservationFee) => hybridFeeOperationKey(fee.reservationId, `reversal:${JSON.stringify(fee.reversalRequest)}`);

export async function settleHybridFee(db: PrismaClient, provider: HybridFeeProvider, env: ActivationEnvironment,
  reservationId: string, now = new Date()) {
  const initial = await db.pinAIReservationFee.findUnique({ where: { reservationId } });
  if (!initial || initial.termsVersion !== TERMS.version) return "DISABLED";
  const collectionAllowed = pinAIHybridBillingAllows(env, initial.organizationId);
  if (!collectionAllowed) {
    const r = await db.reservation.findUnique({ where: { id: reservationId },
      select: { status: true, property: { select: { pinAIFeeExempt: true } } } });
    if (r?.status !== "CANCELLED" && !r?.property.pinAIFeeExempt) return "DISABLED";
  }
  if (initial.billingStatus === "NEEDS_REVIEW") return "NEEDS_REVIEW";
  if (initial.exportNextAttemptAt && initial.exportNextAttemptAt > now) return "NOT_DUE";
  const token = randomUUID();
  const claim = await db.pinAIReservationFee.updateMany({ where: { reservationId,
    exportAttempts: initial.exportAttempts, OR: [{ exportLeaseUntil: null }, { exportLeaseUntil: { lte: now } }] },
    data: { exportLeaseToken: token, exportLeaseUntil: new Date(+now + 90_000), exportAttempts: { increment: 1 } } });
  if (!claim.count) return "BUSY";
  let fee = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId } });
  const save = async (data: Prisma.PinAIReservationFeeUpdateManyMutationInput) => {
    if (!(await db.pinAIReservationFee.updateMany({ where: { reservationId, exportLeaseToken: token }, data })).count)
      throw Error("BILLING_LEASE_LOST");
    fee = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId } });
  };
  const finish = async (status: string, data: Prisma.PinAIReservationFeeUpdateManyMutationInput = {}) => {
    await save({ ...data, billingStatus: status, exportLeaseToken: null, exportLeaseUntil: null, lastError: null,
      exportNextAttemptAt: new Date(+now + 60 * 60_000) });
    return status;
  };
  try {
    if (fee.amountCents !== 100 || fee.currency !== "USD" || !fee.acceptedBy || fee.acceptedAt > fee.recordedAt ||
      !["MEMBERSHIP", "DIRECT_APPLICATION_FEE"].includes(fee.collectionMethod ?? "")) throw Error("HYBRID_FEE_SCOPE_INVALID");
    const r = await db.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: {
      propertyId: true, status: true,
      property: { select: { organizationId: true, pinAIFeeExempt: true } } } });
    if (r.propertyId !== fee.propertyId || r.property.organizationId !== fee.organizationId) throw Error("HYBRID_TENANT_MISMATCH");
    const cancelled = r.status === "CANCELLED" || r.property.pinAIFeeExempt;
    if (fee.collectionMethod === "MEMBERSHIP" && !fee.stripeInvoiceItemId) {
      // If a create timed out, recover it even after cancellation. Never mark
      // an uncertain request excluded: Stripe might already own the item.
      if (!fee.exportStartedAt && cancelled) return finish("REVERSED", { reversedAt: now });
      if (!fee.exportStartedAt) {
        const sub = await db.subscription.findUnique({ where: { organizationId: fee.organizationId } });
        if (!sub?.stripeCustomerId || !sub.stripeSubscriptionId) return finish("PENDING_MEMBERSHIP");
        if (fee.stripeCustomerId && fee.stripeCustomerId !== sub.stripeCustomerId) throw Error("MEMBERSHIP_CHANGED");
        // A renewed membership may have a new subscription. It can be bound
        // only before any external request, retaining the same verified host.
        await save({ stripeCustomerId: sub.stripeCustomerId, stripeSubscriptionId: sub.stripeSubscriptionId });
      }
      const key = hybridFeeOperationKey(reservationId, "item");
      let itemId: string;
      if (fee.exportStartedAt && +now - +fee.exportStartedAt >= REPLAY_MS) {
        const recovered = await provider.reconcile(fee, "ITEM", key);
        if (!recovered) throw Error("ITEM_REPLAY_WINDOW_EXPIRED");
        itemId = recovered;
      } else {
        if (!fee.exportStartedAt) {
          if (!await provider.validateMembership(fee.stripeCustomerId!, fee.stripeSubscriptionId!, fee.organizationId))
            return finish("PENDING_MEMBERSHIP");
          await save({ exportStartedAt: now });
        }
        itemId = (await provider.createItem(fee, key)).id;
      }
      if (!itemId.startsWith("ii_")) throw Error("INVOICE_ITEM_INVALID");
      await save({ stripeInvoiceItemId: itemId, billingStatus: "ON_MEMBERSHIP" });
    }
    if (fee.collectionMethod === "DIRECT_APPLICATION_FEE" && !fee.stripeApplicationFeeId) {
      await save({ stripeApplicationFeeId: await provider.directEvidence(fee) });
    }
    // Recheck after external operations: a concurrent cancellation must win.
    const current = await db.reservation.findUniqueOrThrow({ where: { id: reservationId },
      select: { status: true, property: { select: { pinAIFeeExempt: true } } } });
    const mustReverse = cancelled || current.status === "CANCELLED" || current.property.pinAIFeeExempt;
    if (mustReverse) {
      // Paid direct reservations can receive a later guest refund. Revisit the
      // same application fee to return only the additional commission share.
      if (fee.billingStatus === "REVERSED" && fee.collectionMethod !== "DIRECT_APPLICATION_FEE") return finish("REVERSED");
      if (!fee.reversalStartedAt || fee.billingStatus === "REVERSED") {
        const request = await provider.reversalPlan(fee);
        if (request.kind === "NONE") return finish("REVERSED", { reversedAt: fee.reversedAt ?? now });
        await save({ reversalRequest: request, reversalStartedAt: now, billingStatus: "REVERSING" });
      }
      const key = reversalKey(fee);
      let reversalId: string;
      if (+now - +fee.reversalStartedAt! >= REPLAY_MS) {
        const recovered = await provider.reconcile(fee, "REVERSAL", key);
        if (!recovered) throw Error("REVERSAL_REPLAY_WINDOW_EXPIRED");
        reversalId = recovered;
      } else {
        reversalId = await provider.reverse(fee, fee.reversalRequest as ReversalRequest, key);
      }
      return finish("REVERSED", { stripeReversalId: reversalId, reversedAt: now });
    }
    if (fee.collectionMethod === "DIRECT_APPLICATION_FEE") {
      const feeId = await provider.directEvidence(fee);
      return finish("PAID", { stripeApplicationFeeId: feeId, paidAt: fee.paidAt ?? now });
    }
    const state = await provider.itemState(fee);
    return finish(state.paid ? "PAID" : "ON_MEMBERSHIP", { stripeInvoiceId: state.invoiceId,
      ...(state.paid ? { paidAt: fee.paidAt ?? now } : {}) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "BILLING_OPERATION_FAILED";
    // Stripe request failures can be uncertain. Retain pinned keys and payloads;
    // timeouts retry within retention, then GET-only reconciliation or review.
    const definitiveReversalRejection = message === "HYBRID_REVERSAL_REJECTED";
    const review = /MISMATCH|INVALID|MISSING|EXPIRED|MULTIPLE|CHANGED|NOT_FOUND/.test(message);
    await db.pinAIReservationFee.updateMany({ where: { reservationId, exportLeaseToken: token }, data: {
      exportLeaseToken: null, exportLeaseUntil: null, exportNextAttemptAt: new Date(+now + 60_000),
      lastError: review ? message : "BILLING_OPERATION_RETRY",
      ...(definitiveReversalRejection ? { reversalStartedAt: null } : {}), ...(review ? { billingStatus: "NEEDS_REVIEW" } : {}) } });
    return review ? "NEEDS_REVIEW" : "RETRY";
  }
}
export async function runHybridFeeCycle(db: PrismaClient, provider: HybridFeeProvider, env: ActivationEnvironment,
  now = new Date()) {
  const ids = (env.PIN_AI_HYBRID_BILLING_ORGANIZATION_IDS ?? "").split(",").map(s => s.trim()).filter(s => pinAIHybridBillingAllows(env, s));
  const fees = await db.pinAIReservationFee.findMany({ where: { termsVersion: TERMS.version,
    OR: [
      ...(env.PIN_AI_HYBRID_BILLING_ENABLED === "true" ?
        [env.PIN_AI_ALL_ORGANIZATIONS_ENABLED === "true" ? {} : { organizationId: { in: ids } }] : []),
      { reservation: { status: "CANCELLED" } }, { property: { pinAIFeeExempt: true } },
    ],
    billingStatus: { not: "NEEDS_REVIEW" },
    AND: [{ OR: [{ exportNextAttemptAt: null }, { exportNextAttemptAt: { lte: now } }] },
      { OR: [{ exportLeaseUntil: null }, { exportLeaseUntil: { lte: now } }] }],
  }, orderBy: [{ exportNextAttemptAt: "asc" }, { recordedAt: "asc" }, { reservationId: "asc" }], take: 20 });
  let failures = 0;
  for (const fee of fees) {
    const result = await settleHybridFee(db, provider, env, fee.reservationId, now);
    if (result === "RETRY" || result === "NEEDS_REVIEW") failures++;
  }
  return { attempted: fees.length, failures };
}
