import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { Prisma, type Reservation } from "@prisma/client";
import { createStayTimeStripeProvider, type StayTimeStripeClient } from "./stay-time-stripe-provider.js";
import { syntheticStayTimePaymentEvidence } from "./stay-time-payment-evidence.fixture.js";
import type { StayTimePaymentFlowDependencies, StayTimeRefundRequest } from "./stay-time-payment-flow.service.js";

// Compile-time check against the installed SDK; does not construct a live client.
const acceptsInstalledSdk = (client: Stripe): StayTimeStripeClient => client;
void acceptsInstalledSdk;
function partial<T>(value: Partial<T>): T { return value as T; }
function fixture(platform = "0.15") {
  let now = new Date("2026-10-01T12:10Z");
  const m = partial<Parameters<StayTimePaymentFlowDependencies["retrievePayment"]>[0]>({ id: "mod_test", reservationId: "res_test",
    financialAction: "ADDITIONAL_PAYMENT_REQUIRED", currency: "USD", additionalChargeAmount: new Prisma.Decimal(10),
    additionalPlatformFeeAmount: new Prisma.Decimal(platform), additionalHostPayoutAmount: new Prisma.Decimal(10).minus(platform),
    stripeConnectedAccountId: "acct_test", stripeCheckoutSessionId: "cs_test", stripePaymentIntentId: null, stripeChargeId: null,
    stripeApplicationFeeId: null, stripeTransferId: null, stripePaymentStatus: null, checkoutExpiresAt: new Date("2026-10-01T13:00Z"),
    reservation: partial<Reservation>({ id: "res_test", propertyId: "property_test", stripeConnectedAccountId: "acct_test" }) });
  const objects = syntheticStayTimePaymentEvidence({ ...m, stripePaymentIntentId: "pi_test", stripeChargeId: "ch_test",
    stripeApplicationFeeId: Number(platform) ? "fee_test" : null }, m.reservation, now);
  const request: StayTimeRefundRequest = { modificationId: m.id, connectedAccountId: "acct_test", chargeId: "ch_test", paymentIntentId: "pi_test",
    amountMinor: 1000, platformFeeMinor: Math.round(Number(platform) * 100), currency: "usd", idempotencyKey: "stay-time-recovery:mod_test",
    existingRefundId: null, recoveryStartedAt: "2026-10-01T12:00:00.000Z" };
  const calls: { method: string; args: unknown; options?: Stripe.RequestOptions }[] = [];
  const refunds: Stripe.Refund[] = [];
  const state = { loseFirstResponse: false, pending: false, feeDelayed: false, pageLoop: false, createError: false, slowRead: false };
  function settle(refund: Stripe.Refund) {
    if (refund.status !== "succeeded") return;
    objects.charge.amount_refunded = refund.amount; objects.charge.refunded = refund.amount === 1000;
    if (objects.applicationFee && !state.feeDelayed) {
      objects.applicationFee.amount_refunded = request.platformFeeMinor; objects.applicationFee.refunded = true;
    }
  }
  function makeRefund(overrides: Partial<Stripe.Refund> = {}) {
    const result = partial<Stripe.Refund>({ id: "re_test", object: "refund", amount: 1000, currency: "usd", charge: "ch_test", payment_intent: "pi_test",
      status: "succeeded", transfer_reversal: null, source_transfer_reversal: null,
      metadata: { flow: "stay_time_recovery_v1", reservationModificationId: "mod_test", recoveryKey: request.idempotencyKey }, ...overrides });
    refunds.push(result); settle(result); return result;
  }
  const client: StayTimeStripeClient = {
    checkout: { sessions: { retrieve: async (id, params, options) => {
      calls.push({ method: "session", args: { id, params }, options });
      if (state.slowRead) now = new Date(now.getTime() + 60_001);
      return structuredClone(objects.session);
    } } },
    paymentIntents: { retrieve: async (id, params, options) => { calls.push({ method: "intent", args: { id, params }, options }); return structuredClone(objects.paymentIntent); } },
    charges: { retrieve: async (id, params, options) => { calls.push({ method: "charge", args: { id, params }, options }); return structuredClone(objects.charge); } },
    applicationFees: { retrieve: async id => { calls.push({ method: "fee", args: { id } }); return structuredClone(objects.applicationFee!); } },
    refunds: {
      retrieve: async (id, params, options) => {
        calls.push({ method: "refund-get", args: { id, params }, options });
        const result = refunds.find(r => r.id === id); if (!result) throw new Error("Synthetic refund not found");
        return structuredClone(result);
      },
      list: async (params, options) => {
        calls.push({ method: "refund-list", args: params, options });
        return { object: "list", data: structuredClone(refunds), has_more: state.pageLoop, url: "/v1/refunds" };
      },
      create: async (params, options) => {
        calls.push({ method: "refund-create", args: params, options });
        if (state.createError) throw new Error("Synthetic Stripe outage");
        const refund = refunds[0] ?? makeRefund({ status: state.pending ? "pending" : "succeeded" });
        if (state.loseFirstResponse && calls.filter(c => c.method === "refund-create").length === 1) throw new Error("Synthetic response lost");
        return structuredClone(refund);
      },
    },
  };
  const provider = createStayTimeStripeProvider(client, () => now);
  return { m, objects, request, calls, refunds, state, makeRefund, settle, provider, setNow: (value: string) => { now = new Date(value); } };
}
test("retrieves all payment objects in the connected account and verifies platform fee ownership", async () => {
  const f = fixture(); const evidence = await f.provider.retrievePayment(f.m);
  assert.equal(evidence.paymentIntent.id, "pi_test");
  assert.deepEqual(f.calls.map(c => c.method), ["session", "intent", "charge", "fee"]);
  for (const c of f.calls.filter(c => c.method !== "fee")) assert.deepEqual(c.options, { stripeAccount: "acct_test" });
  assert.equal(f.calls.find(c => c.method === "fee")!.options, undefined);
});
for (const [name, change] of [
  ["changed stored intent", (f: ReturnType<typeof fixture>) => { f.m.stripePaymentIntentId = "pi_other"; }],
  ["wrong session", (f: ReturnType<typeof fixture>) => { f.objects.session.id = "cs_other"; }],
  ["wrong charge", (f: ReturnType<typeof fixture>) => { f.objects.charge.id = "ch_other"; }],
  ["wrong fee owner", (f: ReturnType<typeof fixture>) => { f.objects.applicationFee!.account = "acct_other"; }],
  ["partial refund", (f: ReturnType<typeof fixture>) => { f.objects.charge.amount_refunded = 1; }],
  ["unpaid checkout", (f: ReturnType<typeof fixture>) => { f.objects.session.payment_status = "unpaid"; }],
  ["slow stale retrieval", (f: ReturnType<typeof fixture>) => { f.state.slowRead = true; }],
] as const) test(`payment retrieval rejects ${name}`, async () => {
  const f = fixture(); change(f); await assert.rejects(f.provider.retrievePayment(f.m));
  assert.equal(f.calls.filter(c => c.method === "refund-create").length, 0);
});
for (const fee of ["0.15", "0"]) test(`creates only the incremental full refund, platform fee ${fee}, and reuses its receipt`, async () => {
  const f = fixture(fee); const result = await f.provider.ensureRefund(f.request);
  assert.equal(result.status, "succeeded"); assert.equal(result.platformFeeRefundedMinor, f.request.platformFeeMinor);
  const call = f.calls.find(c => c.method === "refund-create")!;
  assert.deepEqual(call.options, { stripeAccount: "acct_test", idempotencyKey: f.request.idempotencyKey });
  assert.deepEqual(call.args, { charge: "ch_test", amount: 1000, refund_application_fee: Number(fee) > 0,
    metadata: { flow: "stay_time_recovery_v1", reservationModificationId: "mod_test", recoveryKey: f.request.idempotencyKey } });
  f.setNow("2026-10-03T12:00Z");
  assert.equal((await f.provider.ensureRefund(f.request)).refundId, result.refundId);
  assert.equal(f.calls.filter(c => c.method === "refund-create").length, 1);
  for (const c of f.calls.filter(c => c.method !== "fee")) assert.equal(c.options?.stripeAccount, "acct_test");
});
test("lost creation response is recovered by listing the original receipt without creating again", async () => {
  const f = fixture(); f.state.loseFirstResponse = true;
  await assert.rejects(f.provider.ensureRefund(f.request), /response lost/);
  f.setNow("2026-10-03T12:00Z");
  assert.equal((await f.provider.ensureRefund(f.request)).status, "succeeded");
  assert.equal(f.refunds.length, 1); assert.equal(f.calls.filter(c => c.method === "refund-create").length, 1);
});
test("pending refund retrieves the saved ID and completes after settlement", async () => {
  const f = fixture(); f.state.pending = true;
  const pending = await f.provider.ensureRefund(f.request); assert.equal(pending.status, "pending");
  f.refunds[0]!.status = "succeeded"; f.settle(f.refunds[0]!);
  f.setNow("2026-10-03T12:00Z");
  assert.equal((await f.provider.ensureRefund({ ...f.request, existingRefundId: pending.refundId })).status, "succeeded");
  assert.equal(f.calls.filter(c => c.method === "refund-create").length, 1);
});
test("charge refund does not complete recovery until the platform fee is also refunded", async () => {
  const f = fixture(); f.state.feeDelayed = true;
  const result = await f.provider.ensureRefund(f.request); assert.equal(result.status, "pending");
  f.state.feeDelayed = false; f.settle(f.refunds[0]!);
  assert.equal((await f.provider.ensureRefund({ ...f.request, existingRefundId: result.refundId })).status, "succeeded");
  assert.equal(f.calls.filter(c => c.method === "refund-create").length, 1);
});
const invalid: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["old unknown outcome", f => { f.setNow("2026-10-03T12:00Z"); }],
  ["future recovery", f => { f.request.recoveryStartedAt = "2026-10-03T12:00Z"; }],
  ["changed key", f => { f.request.idempotencyKey = "another-key"; }],
  ["base booking payment", f => { f.objects.paymentIntent.metadata.flow = "direct_booking"; }],
  ["another modification", f => { f.objects.paymentIntent.metadata.reservationModificationId = "other"; }],
  ["wrong amount", f => { f.request.amountMinor = 999; }],
  ["disputed charge", f => { f.objects.charge.disputed = true; }],
  ["foreign refund", f => { f.makeRefund({ metadata: {} }); }],
  ["multiple refunds", f => { f.makeRefund(); f.makeRefund({ id: "re_other" }); }],
  ["partial unknown refund", f => { f.objects.charge.amount_refunded = 1; }],
  ["wrong fee account", f => { f.objects.applicationFee!.account = "acct_wrong"; }],
  ["fee refunded without a matching charge receipt", f => { f.objects.applicationFee!.amount_refunded = 1; }],
  ["non-advancing pagination", f => { f.state.pageLoop = true; }],
];
for (const [name, change] of invalid) test(`refund creation is blocked for ${name}`, async () => {
  const f = fixture(); change(f); await assert.rejects(f.provider.ensureRefund(f.request));
  assert.equal(f.calls.filter(c => c.method === "refund-create").length, 0);
});
test("provider outage leaves no false success and can be retried with the identical key", async () => {
  const f = fixture(); f.state.createError = true;
  await assert.rejects(f.provider.ensureRefund(f.request), /Stripe outage/);
  f.state.createError = false; assert.equal((await f.provider.ensureRefund(f.request)).status, "succeeded");
  assert.equal(new Set(f.calls.filter(c => c.method === "refund-create").map(c => c.options?.idempotencyKey)).size, 1);
});
test("failed existing refund is returned for review without replacement creation", async () => {
  const f = fixture(); const failed = f.makeRefund({ status: "failed" });
  assert.equal((await f.provider.ensureRefund({ ...f.request, existingRefundId: failed.id })).status, "failed");
  assert.equal(f.calls.filter(c => c.method === "refund-create").length, 0);
});
test("simultaneous refund retries use one provider key and resolve the same receipt", async () => {
  const f = fixture();
  const results = await Promise.all([f.provider.ensureRefund(f.request), f.provider.ensureRefund(f.request)]);
  assert.deepEqual(results.map(r => r.refundId), ["re_test", "re_test"]);
  assert.equal(f.refunds.length, 1);
  assert.equal(new Set(f.calls.filter(c => c.method === "refund-create").map(c => c.options?.idempotencyKey)).size, 1);
});

test("unpaid expiry adapter retrieves only the exact connected-account session without mutations", async () => {
  const f = fixture(); f.setNow("2026-10-01T14:00Z");
  Object.assign(f.objects.session, { status: "expired", payment_status: "unpaid", payment_intent: null,
    after_expiration: null, recovered_from: null, invoice: null, subscription: null, setup_intent: null });
  const evidence = await f.provider.retrieveUnpaidSession(f.m);
  assert.equal(evidence?.session.id, "cs_test"); assert.deepEqual(f.calls.map(c => c.method), ["session"]);
  assert.deepEqual(f.calls[0].options, { stripeAccount: "acct_test" });
  f.objects.session.payment_intent = "pi_pending";
  await assert.rejects(f.provider.retrieveUnpaidSession(f.m), /STAY_TIME_PAYMENT_EVIDENCE_MISMATCH/);
  f.objects.session.payment_intent = null; f.objects.session.status = "complete";
  assert.equal(await f.provider.retrieveUnpaidSession(f.m), null);
  f.objects.session.status = "expired"; f.state.slowRead = true;
  await assert.rejects(f.provider.retrieveUnpaidSession(f.m), /STAY_TIME_PAYMENT_EVIDENCE_MISMATCH/);
  assert.equal(f.calls.some(c => !["session", "intent"].includes(c.method)), false);
});

test("canceled intent is independently retrieved in the connected account without charges or mutations", async () => {
  const f = fixture(); f.setNow("2026-10-01T14:00Z");
  Object.assign(f.objects.paymentIntent, { status: "canceled", amount_received: 0, amount_capturable: 0,
    latest_charge: null, transfer_data: null, canceled_at: Date.parse("2026-10-01T13:00Z") / 1000 });
  Object.assign(f.objects.session, { status: "expired", payment_status: "unpaid", payment_intent: structuredClone(f.objects.paymentIntent),
    after_expiration: null, recovered_from: null, invoice: null, subscription: null, setup_intent: null });
  const evidence = await f.provider.retrieveUnpaidSession(f.m);
  assert.equal(evidence?.canceledPaymentIntent?.id, "pi_test");
  assert.deepEqual(f.calls.map(c => c.method), ["session", "intent"]);
  assert.deepEqual(f.calls[1].args, { id: "pi_test", params: {} });
  for (const call of f.calls) assert.deepEqual(call.options, { stripeAccount: "acct_test" });
  // Expanded Checkout evidence cannot override a different fresh intent result.
  f.objects.paymentIntent.id = "pi_other";
  await assert.rejects(f.provider.retrieveUnpaidSession(f.m), /STAY_TIME_PAYMENT_EVIDENCE_MISMATCH/);
  assert.equal(f.calls.some(c => !["session", "intent"].includes(c.method)), false);
});
