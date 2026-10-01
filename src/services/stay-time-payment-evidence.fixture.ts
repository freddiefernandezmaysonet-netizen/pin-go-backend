import type Stripe from "stripe";
import type { assertStayTimePaymentEvidence, StayTimePaymentEvidence } from "./stay-time-payment-evidence.js";

// Tests supply only fields consumed by the validator, with Stripe's field types.
function synthetic<T>(value: Partial<T>): T { return value as T; }

/** Synthetic objects for offline tests only; never provider evidence. */
export function syntheticStayTimePaymentEvidence(
  m: Parameters<typeof assertStayTimePaymentEvidence>[0], r: Parameters<typeof assertStayTimePaymentEvidence>[1], now: Date,
): StayTimePaymentEvidence {
  const charge = Math.round(Number(m.additionalChargeAmount) * 100);
  const platform = Math.round(Number(m.additionalPlatformFeeAmount) * 100);
  const host = Math.round(Number(m.additionalHostPayoutAmount) * 100);
  const metadata = { flow: "direct_booking_reservation_modification", stripeChargeMode: "DIRECT_CHARGE",
    reservationModificationId: m.id, reservationId: r.id, propertyId: r.propertyId };
  return {
    connectedAccountId: m.stripeConnectedAccountId!, retrievedAt: now,
    session: synthetic<Stripe.Checkout.Session>({ id: m.stripeCheckoutSessionId!, object: "checkout.session", mode: "payment", status: "complete",
      payment_status: "paid", client_reference_id: m.id, payment_intent: m.stripePaymentIntentId,
      currency: "usd", amount_total: charge, expires_at: Math.floor(m.checkoutExpiresAt!.getTime() / 1000), livemode: false,
      metadata: { ...metadata, connectedAccountId: m.stripeConnectedAccountId!, additionalChargeAmountCents: String(charge),
        additionalPlatformFeeAmountCents: String(platform), additionalHostPayoutAmountCents: String(host) } }),
    paymentIntent: synthetic<Stripe.PaymentIntent>({ id: m.stripePaymentIntentId!, object: "payment_intent", status: "succeeded", amount: charge,
      amount_received: charge, amount_capturable: 0, currency: "usd", application_fee_amount: platform || null,
      latest_charge: m.stripeChargeId, transfer_data: null, metadata, livemode: false }),
    charge: { id: m.stripeChargeId!, object: "charge", status: "succeeded", paid: true, captured: true,
      amount: charge, amount_captured: charge, amount_refunded: 0, refunded: false, disputed: false, currency: "usd",
      payment_intent: m.stripePaymentIntentId, application_fee_amount: platform || null, application_fee: m.stripeApplicationFeeId,
      transfer_data: null, source_transfer: null, livemode: false } as Stripe.Charge,
    applicationFee: platform ? { id: m.stripeApplicationFeeId!, object: "application_fee", amount: platform, currency: "usd",
      account: m.stripeConnectedAccountId!, charge: m.stripeChargeId!, amount_refunded: 0, refunded: false, livemode: false } as Stripe.ApplicationFee : null,
  };
}
