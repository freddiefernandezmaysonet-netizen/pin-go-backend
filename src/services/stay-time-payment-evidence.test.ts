import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { assertStayTimePaymentEvidence } from "./stay-time-payment-evidence.js";
import { syntheticStayTimePaymentEvidence } from "./stay-time-payment-evidence.fixture.js";

function fixture(platform = "0.15") {
  const m: Parameters<typeof assertStayTimePaymentEvidence>[0] = { id: "mod_test", reservationId: "res_test",
    financialAction: "ADDITIONAL_PAYMENT_REQUIRED", currency: "USD", additionalChargeAmount: new Prisma.Decimal(10),
    additionalPlatformFeeAmount: new Prisma.Decimal(platform), additionalHostPayoutAmount: new Prisma.Decimal(10).minus(platform),
    stripeConnectedAccountId: "acct_test", stripeCheckoutSessionId: "cs_test", stripePaymentIntentId: "pi_test", stripeChargeId: "ch_test",
    stripeApplicationFeeId: Number(platform) ? "fee_test" : null, stripeTransferId: null, stripePaymentStatus: "paid",
    checkoutExpiresAt: new Date("2026-10-01T13:00Z") };
  const r = { id: "res_test", propertyId: "property_test", stripeConnectedAccountId: "acct_test" };
  const now = new Date("2026-10-01T12:40Z");
  return { m, r, now, evidence: syntheticStayTimePaymentEvidence(m, r, now) };
}
type Fixture = ReturnType<typeof fixture>;
for (const platform of ["0.15", "0"]) test(`accepts exact captured Direct Charge evidence with platform fee ${platform}`, () => {
  const { m, r, evidence, now } = fixture(platform);
  assert.doesNotThrow(() => assertStayTimePaymentEvidence(m, r, evidence, now));
});
test("accepts expanded object references without changing the contract", () => {
  const { m, r, evidence, now } = fixture();
  evidence.session.payment_intent = evidence.paymentIntent;
  evidence.paymentIntent.latest_charge = evidence.charge;
  evidence.charge.application_fee = evidence.applicationFee;
  assertStayTimePaymentEvidence(m, r, evidence, now);
});
const cases: [string, (f: Fixture) => void][] = [
  ["other provider account", f => { f.evidence.connectedAccountId = "acct_other"; }],
  ["reservation account changed", f => { f.r.stripeConnectedAccountId = "acct_other"; }],
  ["other reservation", f => { f.r.id = "res_other"; }],
  ["other property", f => { f.r.propertyId = "property_other"; }],
  ["stale retrieval", f => { f.evidence.retrievedAt = new Date(f.now.getTime() - 60_001); }],
  ["future retrieval", f => { f.evidence.retrievedAt = new Date(f.now.getTime() + 1); }],
  ["unpaid session", f => { f.evidence.session.payment_status = "unpaid"; }],
  ["incomplete session", f => { f.evidence.session.status = "open"; }],
  ["other session", f => { f.evidence.session.id = "cs_other"; }],
  ["other payment intent", f => { f.evidence.paymentIntent.id = "pi_other"; }],
  ["other charge", f => { f.evidence.charge.id = "ch_other"; }],
  ["different session amount", f => { f.evidence.session.amount_total = 1001; }],
  ["different metadata amount", f => { f.evidence.session.metadata!.additionalChargeAmountCents = "1001"; }],
  ["unbound proposal modification", f => { f.evidence.paymentIntent.metadata.reservationModificationId = "mod_other"; }],
  ["extended provider deadline", f => { f.evidence.session.expires_at++; }],
  ["different currency", f => { f.evidence.charge.currency = "eur"; }],
  ["partial payment", f => { f.evidence.paymentIntent.amount_received = 999; }],
  ["authorization without capture", f => { f.evidence.charge.captured = false; }],
  ["partial capture", f => { f.evidence.charge.amount_captured = 999; }],
  ["partial refund with refunded false", f => { f.evidence.charge.amount_refunded = 1; }],
  ["full refund", f => { f.evidence.charge.refunded = true; }],
  ["disputed charge", f => { f.evidence.charge.disputed = true; }],
  ["missing fee", f => { f.evidence.applicationFee = null; }],
  ["fee refunded", f => { f.evidence.applicationFee!.amount_refunded = 1; }],
  ["fee belongs to another account", f => { f.evidence.applicationFee!.account = "acct_other"; }],
  ["fee belongs to another charge", f => { f.evidence.applicationFee!.charge = "ch_other"; }],
  ["mixed live and test objects", f => { f.evidence.charge.livemode = true; }],
  ["destination transfer", f => { f.evidence.paymentIntent.transfer_data = { destination: "acct_other" }; }],
  ["stored transfer", f => { f.m.stripeTransferId = "tr_other"; }],
  ["stored evidence unpaid", f => { f.m.stripePaymentStatus = "unpaid"; }],
  ["fractional stored cents", f => { f.m.additionalChargeAmount = new Prisma.Decimal("10.001"); }],
  ["invalid fee split", f => { f.m.additionalHostPayoutAmount = new Prisma.Decimal("9.86"); }],
];
for (const [name, change] of cases) test(`rejects ${name}`, () => {
  const f = fixture(); change(f);
  assert.throws(() => assertStayTimePaymentEvidence(f.m, f.r, f.evidence, f.now),
    (error: unknown) => (error as { code?: string }).code === "STAY_TIME_PAYMENT_EVIDENCE_MISMATCH");
});

test("terminal unpaid evidence requires an expired unrecoverable session with no payment attempt", async t => {
  const { assertStayTimeUnpaidExpiryEvidence: verify } = await import("./stay-time-payment-evidence.js");
  function unpaid() {
    const f = fixture(); f.now = new Date("2026-10-01T14:00Z"); f.evidence.retrievedAt = f.now;
    Object.assign(f.m, { stripePaymentStatus: null, stripePaymentIntentId: null, stripeChargeId: null, stripeApplicationFeeId: null });
    Object.assign(f.evidence.session, { status: "expired", payment_status: "unpaid", payment_intent: null,
      after_expiration: null, recovered_from: null, invoice: null, subscription: null, setup_intent: null });
    return f;
  }
  const f = unpaid(); verify(f.m, f.r, f.evidence, f.now);
  const rejected: [string, (f: Fixture) => void][] = [
    ["open session", f => { f.evidence.session.status = "open"; }],
    ["asynchronous payment", f => { f.evidence.session.status = "complete"; f.evidence.session.payment_intent = "pi_pending"; }],
    ["attempt exists", f => { f.evidence.session.payment_intent = "pi_failed"; }],
    ["missing intent field", f => { delete (f.evidence.session as Partial<typeof f.evidence.session>).payment_intent; }],
    ["paid receipt", f => { f.evidence.session.payment_status = "paid"; }],
    ["future expiration", f => { f.now = new Date("2026-10-01T12:00Z"); f.evidence.retrievedAt = f.now; }],
    ["stale read", f => { f.evidence.retrievedAt = new Date(f.now.getTime() - 60_001); }],
    ["future read", f => { f.evidence.retrievedAt = new Date(f.now.getTime() + 1); }],
    ["wrong account", f => { f.evidence.connectedAccountId = "acct_other"; }],
    ["reservation account changed", f => { f.r.stripeConnectedAccountId = "acct_other"; }],
    ["wrong session", f => { f.evidence.session.id = "cs_other"; }],
    ["wrong amount", f => { f.evidence.session.amount_total = 999; }],
    ["wrong metadata", f => { f.evidence.session.metadata!.propertyId = "other"; }],
    ["wrong deadline", f => { f.evidence.session.expires_at--; }],
    ["recovery enabled", f => { f.evidence.session.after_expiration = { recovery: { enabled: true, url: "https://synthetic.invalid", expires_at: 123, allow_promotion_codes: false } }; }],
    ["recovered checkout", f => { f.evidence.session.recovered_from = "cs_original"; }],
    ["invoice", f => { f.evidence.session.invoice = "in_pending"; }],
    ["stored intent", f => { f.m.stripePaymentIntentId = "pi_known"; }],
    ["stored charge", f => { f.m.stripeChargeId = "ch_known"; }],
    ["stored fee", f => { f.m.stripeApplicationFeeId = "fee_known"; }],
    ["stored transfer", f => { f.m.stripeTransferId = "tr_known"; }],
    ["stored paid", f => { f.m.stripePaymentStatus = "paid"; }],
    ["invalid split", f => { f.m.additionalHostPayoutAmount = new Prisma.Decimal(11); }],
  ];
  for (const [name, change] of rejected) await t.test(name, () => { const f = unpaid(); change(f); assert.throws(() => verify(f.m, f.r, f.evidence, f.now)); });
});

test("canceled intent expiry requires terminal zero-fund evidence bound to the exact checkout", async t => {
  const { assertStayTimeUnpaidExpiryEvidence: verify } = await import("./stay-time-payment-evidence.js");
  function canceled() {
    const f = fixture(); f.now = new Date("2026-10-01T14:00Z"); f.evidence.retrievedAt = f.now;
    Object.assign(f.m, { stripePaymentStatus: null, stripeChargeId: null, stripeApplicationFeeId: null });
    Object.assign(f.evidence.session, { status: "expired", payment_status: "unpaid",
      after_expiration: null, recovered_from: null, invoice: null, subscription: null, setup_intent: null });
    Object.assign(f.evidence.paymentIntent, { status: "canceled", amount_received: 0, amount_capturable: 0,
      latest_charge: null, transfer_data: null, canceled_at: Math.floor(f.now.getTime() / 1000) - 60 });
    return { ...f, evidence: { ...f.evidence, canceledPaymentIntent: f.evidence.paymentIntent } };
  }
  for (const stored of [true, false]) {
    const f = canceled(); if (!stored) f.m.stripePaymentIntentId = null;
    verify(f.m, f.r, f.evidence, f.now);
    f.evidence.session.payment_intent = f.evidence.canceledPaymentIntent;
    verify(f.m, f.r, f.evidence, f.now);
  }
  const rejected: [string, (f: ReturnType<typeof canceled>) => void][] = [
    ...(["processing", "requires_action", "requires_capture", "requires_payment_method", "requires_confirmation", "succeeded"] as const)
      .map(status => [status, (f: ReturnType<typeof canceled>) => { f.evidence.canceledPaymentIntent.status = status; }] as [string, (f: ReturnType<typeof canceled>) => void]),
    ["received money", f => { f.evidence.canceledPaymentIntent.amount_received = 1; }],
    ["capturable money", f => { f.evidence.canceledPaymentIntent.amount_capturable = 1; }],
    ["charge exists", f => { f.evidence.canceledPaymentIntent.latest_charge = "ch_failed"; }],
    ["missing charge field", f => { delete (f.evidence.canceledPaymentIntent as Partial<typeof f.evidence.paymentIntent>).latest_charge; }],
    ["different intent", f => { f.evidence.canceledPaymentIntent.id = "pi_other"; }],
    ["different stored intent", f => { f.m.stripePaymentIntentId = "pi_other"; }],
    ["contradictory absent session intent", f => { f.evidence.session.payment_intent = null; }],
    ["wrong object", f => { Object.assign(f.evidence.canceledPaymentIntent, { object: "charge" }); }],
    ["wrong amount", f => { f.evidence.canceledPaymentIntent.amount++; }],
    ["wrong fee", f => { f.evidence.canceledPaymentIntent.application_fee_amount = 1; }],
    ["wrong currency", f => { f.evidence.canceledPaymentIntent.currency = "eur"; }],
    ["other reservation", f => { f.evidence.canceledPaymentIntent.metadata.reservationId = "other"; }],
    ["other property", f => { f.evidence.canceledPaymentIntent.metadata.propertyId = "other"; }],
    ["other modification", f => { f.evidence.canceledPaymentIntent.metadata.reservationModificationId = "other"; }],
    ["base booking flow", f => { f.evidence.canceledPaymentIntent.metadata.flow = "direct_booking"; }],
    ["mixed live mode", f => { f.evidence.canceledPaymentIntent.livemode = !f.evidence.session.livemode; }],
    ["transfer", f => { f.evidence.canceledPaymentIntent.transfer_data = { destination: "acct_other" }; }],
    ["missing cancellation time", f => { f.evidence.canceledPaymentIntent.canceled_at = null; }],
    ["future cancellation time", f => { f.evidence.canceledPaymentIntent.canceled_at = Math.floor(f.now.getTime() / 1000) + 1; }],
    ["stale read", f => { f.evidence.retrievedAt = new Date(f.now.getTime() - 60_001); }],
    ["stored charge", f => { f.m.stripeChargeId = "ch_known"; }],
  ];
  for (const [name, change] of rejected) await t.test(name, () => {
    const f = canceled(); change(f); assert.throws(() => verify(f.m, f.r, f.evidence, f.now));
  });
});
