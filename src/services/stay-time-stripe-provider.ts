import type Stripe from "stripe";
import { StayTimePolicyError } from "../pin-ai/actions/stay-time-policy.js";
import { assertStayTimePaymentEvidence, assertStayTimeUnpaidExpiryEvidence, type StayTimeUnpaidExpiryEvidence } from "./stay-time-payment-evidence.js";
import type { StayTimePaymentFlowDependencies, StayTimeRefundRequest, StayTimeRefundEvidence } from "./stay-time-payment-flow.service.js";

export type StayTimeStripeClient = {
  checkout: { sessions: { retrieve: (id: string, params: Stripe.Checkout.SessionRetrieveParams, options: Stripe.RequestOptions) => Promise<Stripe.Checkout.Session> } };
  paymentIntents: { retrieve: (id: string, params: Stripe.PaymentIntentRetrieveParams, options: Stripe.RequestOptions) => Promise<Stripe.PaymentIntent> };
  charges: { retrieve: (id: string, params: Stripe.ChargeRetrieveParams, options: Stripe.RequestOptions) => Promise<Stripe.Charge> };
  applicationFees: { retrieve: (id: string) => Promise<Stripe.ApplicationFee> };
  refunds: {
    retrieve: (id: string, params: Stripe.RefundRetrieveParams, options: Stripe.RequestOptions) => Promise<Stripe.Refund>;
    list: (params: Stripe.RefundListParams, options: Stripe.RequestOptions) => Promise<Stripe.ApiList<Stripe.Refund>>;
    create: (params: Stripe.RefundCreateParams, options: Stripe.RequestOptions) => Promise<Stripe.Refund>;
  };
};
function reject(code = "STAY_TIME_STRIPE_EVIDENCE_MISMATCH"): never { throw new StayTimePolicyError(code); }
function id(value: unknown): string {
  const result = typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? value.id : null;
  if (typeof result !== "string" || !result || result.trim() !== result) reject();
  return result;
}
const PAYMENT_FLOW = "direct_booking_reservation_modification";
const RECOVERY_FLOW = "stay_time_recovery_v1";

/** Existing Stripe instance is explicitly injected. Construction performs no I/O;
 * no guest route, webhook, worker, SDK upgrade or production activation here. */
export function createStayTimeStripeProvider(stripe: StayTimeStripeClient, now: () => Date):
  Pick<StayTimePaymentFlowDependencies, "retrievePayment" | "ensureRefund"> & {
    retrieveUnpaidSession: (m: Parameters<StayTimePaymentFlowDependencies["retrievePayment"]>[0]) => Promise<StayTimeUnpaidExpiryEvidence | null>;
  } {
  return {
    retrievePayment: async m => {
      const startedAt = now();
      const account = id(m.stripeConnectedAccountId);
      if (account !== m.reservation.stripeConnectedAccountId) reject();
      const options = { stripeAccount: account };
      const session = await stripe.checkout.sessions.retrieve(id(m.stripeCheckoutSessionId), {}, options);
      const intentId = id(session.payment_intent);
      const paymentIntent = await stripe.paymentIntents.retrieve(intentId, {}, options);
      if (paymentIntent.id !== intentId) reject();
      const chargeId = id(paymentIntent.latest_charge);
      const charge = await stripe.charges.retrieve(chargeId, {}, options);
      if (charge.id !== chargeId) reject();
      const feeId = charge.application_fee ? id(charge.application_fee) : null;
      // Application fees belong to the platform. Their account and charge links
      // are checked against the connected-account charge below.
      const applicationFee = feeId ? await stripe.applicationFees.retrieve(feeId) : null;
      if (applicationFee && applicationFee.id !== feeId) reject();
      const evidence = { connectedAccountId: account, retrievedAt: startedAt, session, paymentIntent, charge, applicationFee };
      assertStayTimePaymentEvidence({ ...m, stripePaymentStatus: "paid",
        stripePaymentIntentId: m.stripePaymentIntentId ?? intentId, stripeChargeId: m.stripeChargeId ?? chargeId,
        stripeApplicationFeeId: m.stripeApplicationFeeId ?? feeId }, m.reservation, evidence, now());
      return evidence;
    },
    retrieveUnpaidSession: async m => {
      const retrievedAt = now();
      const account = id(m.stripeConnectedAccountId);
      if (account !== m.reservation.stripeConnectedAccountId) reject();
      const session = await stripe.checkout.sessions.retrieve(id(m.stripeCheckoutSessionId), {}, { stripeAccount: account });
      if (session.status !== "expired" || session.payment_status !== "unpaid") return null;
      // Always retrieve the intent independently in this account, even when
      // Checkout supplied an expanded object. This adapter never cancels it.
      const evidence: StayTimeUnpaidExpiryEvidence = { connectedAccountId: account, retrievedAt, session,
        ...(session.payment_intent !== null ? { canceledPaymentIntent:
          await stripe.paymentIntents.retrieve(id(session.payment_intent), {}, { stripeAccount: account }) } : {}) };
      assertStayTimeUnpaidExpiryEvidence(m, m.reservation, evidence, now());
      return evidence;
    },
    ensureRefund: async request => ensureRefund(stripe, request, now),
  };
}

async function ensureRefund(stripe: StayTimeStripeClient, r: StayTimeRefundRequest, now: () => Date): Promise<StayTimeRefundEvidence> {
  const age = () => now().getTime() - Date.parse(r.recoveryStartedAt);
  if (![r.modificationId, r.connectedAccountId, r.chargeId, r.paymentIntentId].every(v => typeof v === "string" && v.trim() === v && v.length > 0) ||
      r.idempotencyKey !== `stay-time-recovery:${r.modificationId}` || r.currency !== "usd" ||
      !Number.isSafeInteger(r.amountMinor) || r.amountMinor <= 0 || !Number.isSafeInteger(r.platformFeeMinor) ||
      r.platformFeeMinor < 0 || r.platformFeeMinor > r.amountMinor || !Number.isFinite(age()) || age() < 0) reject("STAY_TIME_REFUND_REQUEST_INVALID");
  const options = { stripeAccount: r.connectedAccountId };
  const pi = await stripe.paymentIntents.retrieve(r.paymentIntentId, {}, options);
  const charge = await stripe.charges.retrieve(r.chargeId, {}, options);
  if (pi.id !== r.paymentIntentId || pi.object !== "payment_intent" || pi.status !== "succeeded" ||
      pi.amount !== r.amountMinor || pi.amount_received !== r.amountMinor || pi.amount_capturable !== 0 || pi.currency !== r.currency ||
      id(pi.latest_charge) !== r.chargeId || (pi.application_fee_amount ?? 0) !== r.platformFeeMinor || pi.transfer_data ||
      pi.metadata.flow !== PAYMENT_FLOW || pi.metadata.stripeChargeMode !== "DIRECT_CHARGE" || pi.metadata.reservationModificationId !== r.modificationId ||
      charge.id !== r.chargeId || charge.object !== "charge" || id(charge.payment_intent) !== pi.id || charge.status !== "succeeded" ||
      charge.paid !== true || charge.captured !== true || charge.amount !== r.amountMinor || charge.amount_captured !== r.amountMinor ||
      charge.currency !== r.currency || charge.disputed !== false || (charge.application_fee_amount ?? 0) !== r.platformFeeMinor ||
      charge.transfer_data || charge.transfer || charge.source_transfer || typeof charge.livemode !== "boolean" || charge.livemode !== pi.livemode ||
      !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || charge.amount_refunded > r.amountMinor) reject();
  const feeId = charge.application_fee ? id(charge.application_fee) : null;
  async function readFee() {
    if (r.platformFeeMinor === 0) { if (feeId) reject(); return null; }
    if (!feeId) reject();
    const fee = await stripe.applicationFees.retrieve(feeId);
    if (fee.id !== feeId || fee.object !== "application_fee" || id(fee.account) !== r.connectedAccountId || id(fee.charge) !== r.chargeId ||
        fee.amount !== r.platformFeeMinor || fee.currency !== r.currency || fee.livemode !== charge.livemode ||
        !Number.isSafeInteger(fee.amount_refunded) || fee.amount_refunded < 0 || fee.amount_refunded > r.platformFeeMinor) reject();
    return fee;
  }
  const initialFee = await readFee(); // Verify the fee destination before any mutation.
  let refund: Stripe.Refund | undefined;
  if (r.existingRefundId) {
    refund = await stripe.refunds.retrieve(r.existingRefundId, {}, options);
    if (refund.id !== r.existingRefundId) reject();
  } else {
    let cursor: string | undefined;
    // A full incremental refund should have one receipt. Ambiguous/foreign or
    // unexpectedly large histories require review, never another automatic debit.
    for (let page = 0; ; page++) {
      if (page >= 10) reject("STAY_TIME_REFUND_REVIEW_REQUIRED");
      const listed = await stripe.refunds.list({ charge: r.chargeId, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, options);
      for (const candidate of listed.data) {
        if (refund || candidate.metadata?.flow !== RECOVERY_FLOW || candidate.metadata.reservationModificationId !== r.modificationId ||
            candidate.metadata.recoveryKey !== r.idempotencyKey) reject("STAY_TIME_REFUND_REVIEW_REQUIRED");
        refund = candidate;
      }
      if (!listed.has_more) break;
      const next = listed.data.at(-1)?.id;
      if (!next || next === cursor) reject("STAY_TIME_REFUND_REVIEW_REQUIRED");
      cursor = next;
    }
    if (refund) {
      const foundId = refund.id;
      refund = await stripe.refunds.retrieve(foundId, {}, options);
      if (refund.id !== foundId) reject();
    }
  }
  if (!refund) {
    // Stripe may prune keys after 24h. A journal older than 23h permits recovery
    // of an existing receipt, but never a blind new creation after an unknown result.
    if (age() >= 23 * 60 * 60_000 || charge.amount_refunded !== 0 || charge.refunded !== false ||
        (initialFee && initialFee.amount_refunded !== 0)) reject("STAY_TIME_REFUND_REVIEW_REQUIRED");
    refund = await stripe.refunds.create({ charge: r.chargeId, amount: r.amountMinor,
      refund_application_fee: r.platformFeeMinor > 0,
      metadata: { flow: RECOVERY_FLOW, reservationModificationId: r.modificationId, recoveryKey: r.idempotencyKey } },
    { ...options, idempotencyKey: r.idempotencyKey });
  }
  if (refund.object !== "refund" || !refund.id || id(refund.charge) !== r.chargeId || id(refund.payment_intent) !== r.paymentIntentId ||
      refund.amount !== r.amountMinor || refund.currency !== r.currency || refund.metadata?.flow !== RECOVERY_FLOW ||
      refund.metadata.reservationModificationId !== r.modificationId || refund.metadata.recoveryKey !== r.idempotencyKey ||
      refund.transfer_reversal || refund.source_transfer_reversal ||
      !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(refund.status ?? "")) reject("STAY_TIME_REFUND_EVIDENCE_MISMATCH");
  const freshCharge = await stripe.charges.retrieve(r.chargeId, {}, options);
  if (freshCharge.id !== r.chargeId || id(freshCharge.payment_intent) !== r.paymentIntentId || freshCharge.currency !== r.currency ||
      freshCharge.amount !== r.amountMinor || freshCharge.disputed !== false || freshCharge.livemode !== charge.livemode) reject();
  const fee = await readFee();
  const settled = refund.status === "succeeded" && freshCharge.amount_refunded === r.amountMinor && freshCharge.refunded === true &&
    (!fee || (fee.amount_refunded === r.platformFeeMinor && fee.refunded === true));
  return { refundId: refund.id, connectedAccountId: r.connectedAccountId, chargeId: r.chargeId, paymentIntentId: r.paymentIntentId,
    amountMinor: r.amountMinor, currency: r.currency, platformFeeRefundedMinor: fee?.amount_refunded ?? 0,
    status: settled ? "succeeded" : refund.status === "failed" || refund.status === "canceled" ? "failed" : "pending" };
}
