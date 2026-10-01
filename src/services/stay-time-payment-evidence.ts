import type Stripe from "stripe";
import type { Reservation, ReservationModification } from "@prisma/client";
import { StayTimePolicyError } from "../pin-ai/actions/stay-time-policy.js";

/** Only a server-side provider adapter may construct this after scoped retrieval.
 * Never accept these objects, the account or retrieval time from a guest request.
 * This pure validator neither authenticates webhook signatures nor fetches Stripe.
 */
export type StayTimePaymentEvidence = {
  connectedAccountId: string;
  retrievedAt: Date;
  session: Stripe.Checkout.Session;
  paymentIntent: Stripe.PaymentIntent;
  charge: Stripe.Charge;
  applicationFee: Stripe.ApplicationFee | null;
};
type Modification = Pick<ReservationModification, "id" | "reservationId" | "financialAction" | "currency" |
  "additionalChargeAmount" | "additionalPlatformFeeAmount" | "additionalHostPayoutAmount" |
  "stripeConnectedAccountId" | "stripeCheckoutSessionId" | "stripePaymentIntentId" | "stripeChargeId" |
  "stripeApplicationFeeId" | "stripeTransferId" | "stripePaymentStatus" | "checkoutExpiresAt">;
type Stay = Pick<Reservation, "id" | "propertyId" | "stripeConnectedAccountId">;
function reject(): never { throw new StayTimePolicyError("STAY_TIME_PAYMENT_EVIDENCE_MISMATCH"); }
function id(value: unknown): string | null {
  const candidate = typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? value.id : null;
  return typeof candidate === "string" && candidate.trim() === candidate && candidate.length > 0 ? candidate : null;
}
function cents(value: Modification["additionalChargeAmount"]): number {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) reject();
  const [whole, fraction = ""] = text.split(".");
  const result = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) reject();
  return Number(result);
}

/** Validates fresh retrieved objects against persisted payment references.
 * Success is evidence consistency only: current consent/availability, deadlines,
 * transactional application and failure/refund recovery remain separate gates.
 */
export function assertStayTimePaymentEvidence(m: Modification, r: Stay, evidence: StayTimePaymentEvidence, now: Date): void {
  const { session: s, paymentIntent: pi, charge: c, applicationFee: fee } = evidence;
  const age = now.getTime() - evidence.retrievedAt.getTime();
  const account = id(m.stripeConnectedAccountId);
  const charge = cents(m.additionalChargeAmount), platform = cents(m.additionalPlatformFeeAmount), host = cents(m.additionalHostPayoutAmount);
  if (!Number.isFinite(age) || age < 0 || age > 60_000 || !account ||
      account !== r.stripeConnectedAccountId || account !== evidence.connectedAccountId || m.reservationId !== r.id ||
      m.financialAction !== "ADDITIONAL_PAYMENT_REQUIRED" || m.stripePaymentStatus !== "paid" || m.stripeTransferId ||
      m.currency.toUpperCase() !== "USD" || charge <= 0 || platform + host !== charge ||
      !id(m.stripeCheckoutSessionId) || !id(m.stripePaymentIntentId) || !id(m.stripeChargeId) ||
      !m.checkoutExpiresAt || !Number.isFinite(m.checkoutExpiresAt.getTime())) reject();
  const metadata = s.metadata;
  if (s.id !== m.stripeCheckoutSessionId || s.object !== "checkout.session" || s.mode !== "payment" ||
      s.status !== "complete" || s.payment_status !== "paid" || s.client_reference_id !== m.id ||
      id(s.payment_intent) !== m.stripePaymentIntentId || s.currency !== "usd" || s.amount_total !== charge ||
      s.expires_at !== Math.floor(m.checkoutExpiresAt.getTime() / 1000) ||
      metadata?.flow !== "direct_booking_reservation_modification" || metadata.stripeChargeMode !== "DIRECT_CHARGE" ||
      metadata.connectedAccountId !== account || metadata.reservationModificationId !== m.id ||
      metadata.reservationId !== r.id || metadata.propertyId !== r.propertyId ||
      metadata.additionalChargeAmountCents !== String(charge) || metadata.additionalPlatformFeeAmountCents !== String(platform) ||
      metadata.additionalHostPayoutAmountCents !== String(host)) reject();
  if (pi.id !== m.stripePaymentIntentId || pi.object !== "payment_intent" || pi.status !== "succeeded" ||
      pi.amount !== charge || pi.amount_received !== charge || pi.amount_capturable !== 0 || pi.currency !== "usd" ||
      (pi.application_fee_amount ?? 0) !== platform || id(pi.latest_charge) !== m.stripeChargeId || pi.transfer_data ||
      pi.metadata.flow !== "direct_booking_reservation_modification" || pi.metadata.stripeChargeMode !== "DIRECT_CHARGE" ||
      pi.metadata.reservationModificationId !== m.id || pi.metadata.reservationId !== r.id || pi.metadata.propertyId !== r.propertyId) reject();
  // paid=true alone also covers authorization without capture; partial refunds
  // leave refunded=false. Require the complete, undisputed, unrefunded capture.
  if (c.id !== m.stripeChargeId || c.object !== "charge" || c.status !== "succeeded" || c.paid !== true || c.captured !== true ||
      c.amount !== charge || c.amount_captured !== charge || c.amount_refunded !== 0 || c.refunded !== false || c.disputed !== false ||
      c.currency !== "usd" || id(c.payment_intent) !== pi.id || (c.application_fee_amount ?? 0) !== platform ||
      c.transfer_data || c.transfer || c.source_transfer ||
      typeof s.livemode !== "boolean" || s.livemode !== pi.livemode || s.livemode !== c.livemode) reject();
  if (platform === 0) {
    if (fee || c.application_fee || m.stripeApplicationFeeId) reject();
  } else if (!fee || !id(m.stripeApplicationFeeId) || fee.object !== "application_fee" ||
      fee.id !== m.stripeApplicationFeeId || id(c.application_fee) !== fee.id || fee.amount !== platform ||
      fee.currency !== "usd" || id(fee.account) !== account || id(fee.charge) !== c.id ||
      fee.amount_refunded !== 0 || fee.refunded !== false || fee.livemode !== s.livemode) reject();
}
