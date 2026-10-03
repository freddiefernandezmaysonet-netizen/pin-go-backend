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
