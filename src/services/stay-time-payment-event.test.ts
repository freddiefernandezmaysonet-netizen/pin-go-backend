import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import type { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { handleStayTimePaymentEvent } from "./stay-time-payment-event.service.js";

function fixture() {
  const row = { id: "mod_test", requestSource: "PIN_AI_GUEST_SERVICES",
    guestConfirmation: { operation: "LATE_CHECKOUT" }, stripeConnectedAccountId: "acct_test", stripeCheckoutSessionId: "cs_test" };
  const session = { object: "checkout.session", id: "cs_test", client_reference_id: row.id, mode: "payment",
    payment_status: "paid", livemode: false,
    metadata: { flow: "direct_booking_reservation_modification", reservationModificationId: row.id, connectedAccountId: "acct_test" } };
  const event = { id: "evt_test", object: "event", type: "checkout.session.completed", account: "acct_test", livemode: false,
    data: { object: session } };
  let calls = 0;
  const deps = { client: { reservationModification: { findUnique: async () => row } } as unknown as PrismaClient,
    processPayment: async (scope: { modificationId: string; checkoutSessionId: string; connectedAccountId: string }) => {
      calls++;
      assert.deepEqual(scope, { modificationId: row.id, checkoutSessionId: row.stripeCheckoutSessionId, connectedAccountId: row.stripeConnectedAccountId });
      return { outcome: "REFUNDED" as const, actionExecuted: false as const };
    } };
  return { row, session, event, deps, calls: () => calls, run: () => handleStayTimePaymentEvent(event as unknown as Stripe.Event, deps) };
}

for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
  test(`${type}: signed event dispatches and duplicate delivery reuses the canonical processor`, async () => {
    const f = fixture(); f.event.type = type;
    const stripe = new Stripe("sk_test_offline", { apiVersion: "2023-10-16" });
    const payload = JSON.stringify(f.event);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_offline" });
    const verified = stripe.webhooks.constructEvent(payload, signature, "whsec_offline");
    assert.equal((await handleStayTimePaymentEvent(verified, f.deps)).handled, true);
    assert.equal((await handleStayTimePaymentEvent(verified, f.deps)).handled, true);
    assert.equal(f.calls(), 2);
    assert.throws(() => stripe.webhooks.constructEvent(payload.replace("acct_test", "acct_other"), signature, "whsec_offline"));
  });
}
for (const [name, change] of [
  ["wrong signed account", (f: ReturnType<typeof fixture>) => { f.event.account = "acct_other"; }],
  ["missing signed account", (f: ReturnType<typeof fixture>) => { f.event.account = ""; }],
  ["metadata account mismatch", (f: ReturnType<typeof fixture>) => { f.session.metadata.connectedAccountId = "acct_other"; }],
  ["wrong session", (f: ReturnType<typeof fixture>) => { f.session.id = "cs_other"; }],
  ["wrong reference", (f: ReturnType<typeof fixture>) => { f.session.client_reference_id = "mod_other"; }],
  ["wrong source", (f: ReturnType<typeof fixture>) => { f.row.requestSource = "MANUAL"; }],
  ["wrong mode", (f: ReturnType<typeof fixture>) => { f.session.mode = "subscription"; }],
  ["wrong object", (f: ReturnType<typeof fixture>) => { f.session.object = "payment_intent"; }],
  ["mixed live/test", (f: ReturnType<typeof fixture>) => { f.session.livemode = true; }],
] as const) test(`rejects ${name} before processing`, async () => {
  const f = fixture(); change(f); await assert.rejects(f.run(), /SCOPE_MISMATCH/); assert.equal(f.calls(), 0);
});
test("both event types wait for settled payment", async () => {
  for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
    const f = fixture(); f.event.type = type; f.session.payment_status = "unpaid";
    assert.deepEqual(await f.run(), { handled: true, outcome: "PAYMENT_PENDING" }); assert.equal(f.calls(), 0);
  }
});
test("unrelated events and general modifications retain existing dispatch", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.event.type = "payment_intent.succeeded"; },
    (f: ReturnType<typeof fixture>) => { f.session.metadata.flow = "direct_booking"; },
    (f: ReturnType<typeof fixture>) => { f.row.guestConfirmation.operation = "DATE_CHANGE"; },
  ]) {
    const f = fixture(); change(f); assert.deepEqual(await f.run(), { handled: false }); assert.equal(f.calls(), 0);
  }
});
test("provider failure propagates to the event ledger and a retry can finish", async () => {
  const f = fixture(); const original = f.deps.processPayment;
  f.deps.processPayment = async () => { throw new Error("provider unavailable"); };
  await assert.rejects(f.run(), /provider unavailable/);
  f.deps.processPayment = original; assert.equal((await f.run()).handled, true);
});
test("pending refund is not acknowledged as a completed financial event", async () => {
  const f = fixture();
  await assert.rejects(handleStayTimePaymentEvent(f.event as unknown as Stripe.Event, {
    ...f.deps, processPayment: async () => ({ outcome: "REFUND_PENDING", actionExecuted: false }),
  }), /RECOVERY_PENDING/);
});
test("live webhook passes the verified event through both Checkout branches", () => {
  const source = readFileSync("src/webhooks/stripe.webhook.ts", "utf8");
  assert.equal(source.match(/await handleModificationPaymentEvent\(event, session\)/g)?.length, 2);
  assert.ok(source.indexOf("stripe.webhooks.constructEvent") < source.indexOf("switch (event.type)"));
  assert.match(source, /if \(result.handled\) return result;\s+return handleGuestReservationModificationCheckoutPaid\(session\)/);
});
