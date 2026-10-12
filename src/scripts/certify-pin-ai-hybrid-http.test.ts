import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { PIN_AI_HYBRID_BILLING_TERMS as TERMS } from "../pin-ai/billing-terms.js";

const enabled = process.env.PIN_AI_HYBRID_HTTP_TEST === "true";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "http://missing");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.equal(url.pathname, "/pin_ai_activation_test");
  assert.equal(process.env.STRIPE_SECRET_KEY, "sk_test_synthetic_http_only");
  for (const key of ["RESEND_API_KEY", "TWILIO_AUTH_TOKEN", "CHANNEX_API_KEY", "TTLOCK_ACCESS_TOKEN"])
    assert.ok(!process.env[key], `External effects credential forbidden: ${key}`);
}

test("HTTP checkout, signed webhook, native reservation ledger and worker share one hybrid obligation", { skip: !enabled, timeout: 60000 }, async t => {
  const db = new PrismaClient();
  const sdk = new Stripe("sk_test_synthetic_http_only", { apiVersion: "2023-10-16" });
  // Only external Stripe transport is simulated. Public HTTP, signature validation,
  // ingest, PostgreSQL, event replay and production fee cycle execute normally.
  const resource = (value: unknown) => Object.getPrototypeOf(value);
  const accountId = "acct_synthetic_http";
  let session: any, payment: any, appFeeReturned = 0, feeRefundCalls = 0;
  t.mock.method(resource(sdk.accounts), "retrieve", async () => ({ id: accountId,
    charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] } }));
  t.mock.method(resource(sdk.checkout.sessions), "create", async (params: any, options: any) => {
    assert.equal(options.stripeAccount, accountId);
    assert.equal(Object.keys(params.metadata).length, 50);
    assert.equal(params.payment_intent_data.application_fee_amount,
      Math.round(Number(params.metadata.basePlatformFeeAmount) * 100) + 100);
    assert.equal(params.line_items[0].price_data.unit_amount, 10000);
    payment = { id: "pi_synthetic_http", status: "succeeded", currency: "usd", amount_received: 10000,
      application_fee_amount: params.payment_intent_data.application_fee_amount,
      metadata: params.payment_intent_data.metadata,
      latest_charge: { id: "ch_synthetic_http", paid: true, currency: "usd", amount: 10000,
        amount_refunded: 0, application_fee: "fee_synthetic_http", balance_transaction: null } };
    session = { id: "cs_test_synthetic_http", object: "checkout.session", livemode: false, mode: "payment",
      status: "complete", payment_status: "paid", amount_total: 10000, currency: "usd",
      metadata: params.metadata, payment_intent: payment.id, url: "https://example.com/synthetic-checkout" };
    return session;
  });
  t.mock.method(resource(sdk.paymentIntents), "retrieve", async (_id: string, _params: any, options: any) => {
    assert.equal(options.stripeAccount, accountId); return payment;
  });
  t.mock.method(resource(sdk.applicationFees), "retrieve", async () => ({ id: "fee_synthetic_http",
    account: accountId, charge: "ch_synthetic_http", amount: payment.application_fee_amount,
    amount_refunded: appFeeReturned, currency: "usd" }));
  t.mock.method(resource(sdk.applicationFees), "createRefund", async (_id: string, params: any) => {
    feeRefundCalls++; appFeeReturned += params.amount; return { id: "fr_synthetic_http" };
  });
  process.env.PIN_AI_PROPERTY_ACTIVATION_ENABLED = "true";
  process.env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED = "true";
  process.env.PIN_AI_HYBRID_BILLING_ENABLED = "true";
  const org = await db.organization.create({ data: { name: "Synthetic HTTP hybrid", slug: "synthetic-http-hybrid",
    publicBookingEnabled: true, pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: accountId } });
  process.env.PIN_AI_HYBRID_BILLING_ORGANIZATION_IDS = org.id;
  const property = await db.property.create({ data: { name: "Synthetic HTTP hybrid", organizationId: org.id,
    isPublicBookable: true, baseNightlyRate: 100, minimumNights: 1, timezone: "UTC", checkInTime: "16:00", checkOutTime: "11:00",
    pinAIEnabled: true, pinAIRevision: 1, pinAITermsVersion: TERMS.version,
    pinAITermsAcceptedAt: new Date(Date.now() - 60000), pinAITermsAcceptedBy: "synthetic-host" } });
  await db.propertyGuestAgreement.create({ data: { propertyId: property.id, version: "synthetic-v1", title: "Synthetic",
    agreementText: "Synthetic", requiresIdentityVerification: false, requiresAgreementSignature: false } });
  const { default: router } = await import("../routes/public-booking.routes.js");
  const { registerStripeWebhook } = await import("../webhooks/stripe.webhook.js");
  const { runHybridFeeCycle } = await import("../pin-ai/hybrid-fee.service.js");
  const { createHybridFeeStripeProvider } = await import("../pin-ai/hybrid-fee-stripe.provider.js");
  const app = express(); registerStripeWebhook(app); app.use(express.json()); app.use("/api/public-booking", router);
  const server = await new Promise<import("node:http").Server>(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, signature?: string) => fetch(base + path, { method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) }, body: JSON.stringify(body) });
  try {
    const checkout = await post("/api/public-booking/create-checkout", { propertyId: property.id,
      checkIn: "2030-01-02", checkOut: "2030-01-03", guestName: "Synthetic", guestEmail: "synthetic@example.com",
      adults: 1, children: 0, guestAcceptedCancellationTerms: true, guestAcceptedSecurePreCheckinRequirement: true });
    const checkoutBody = await checkout.json(); assert.equal(checkout.status, 200, JSON.stringify(checkoutBody));
    assert.equal(checkoutBody.totalAmount, 100);
    const event = { id: "evt_synthetic_http_hybrid", object: "event", type: "checkout.session.completed",
      account: accountId, livemode: false, created: Math.floor(Date.now() / 1000), data: { object: session } };
    const invalid = await post("/webhooks/stripe", event, "invalid"); assert.equal(invalid.status, 400);
    assert.equal(await db.reservation.count({ where: { propertyId: property.id } }), 0);
    const signature = sdk.webhooks.generateTestHeaderString({ payload: JSON.stringify(event),
      secret: process.env.STRIPE_WEBHOOK_SECRET! });
    const response = await post("/webhooks/stripe", event, signature);
    const webhookBody = await response.json(); assert.equal(response.status, 200, JSON.stringify(webhookBody));
    const duplicate = await post("/webhooks/stripe", event, signature);
    assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
    const reservation = await db.reservation.findFirstOrThrow({ where: { propertyId: property.id } });
    assert.equal(reservation.status, "ACTIVE"); assert.equal(reservation.paymentState, "PAID");
    assert.equal(Number(reservation.amountCollected), 100);
    assert.equal(await db.reservation.count({ where: { propertyId: property.id } }), 1);
    assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: reservation.id } }), 1);
    const fee = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: reservation.id } });
    assert.equal(fee.amountCents, 100); assert.equal(fee.acceptedBy, "synthetic-host");
    assert.equal(fee.collectionMethod, "DIRECT_APPLICATION_FEE");
    assert.equal(fee.stripePaymentIntentId, payment.id);
    const { auditReservationCompleteFlow } = await import("../services/reservation-complete-flow-audit.service.js");
    const audit = await auditReservationCompleteFlow(reservation.id, db);
    assert.equal(audit.checks.find(check => check.rule === "IDENTITY_CHECK_CONNECT_FEE_BREAKDOWN")?.status, "PASS");
    const provider = createHybridFeeStripeProvider(sdk);
    assert.equal((await runHybridFeeCycle(db, provider, process.env)).failures, 0);
    assert.equal((await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: reservation.id } })).billingStatus, "PAID");
    await db.reservation.update({ where: { id: reservation.id }, data: { status: "CANCELLED" } });
    await db.pinAIReservationFee.update({ where: { reservationId: reservation.id }, data: { exportNextAttemptAt: null } });
    assert.equal((await runHybridFeeCycle(db, provider, process.env)).failures, 0);
    assert.equal(appFeeReturned, 100); assert.equal(feeRefundCalls, 1);
    assert.equal((await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: reservation.id } })).billingStatus, "REVERSED");
    await db.pinAIReservationFee.update({ where: { reservationId: reservation.id }, data: { exportNextAttemptAt: null } });
    await runHybridFeeCycle(db, provider, process.env); assert.equal(feeRefundCalls, 1);
    console.log(JSON.stringify({ certificate: "PIN_AI_HYBRID_HTTP", certified: true,
      scope: "REAL_HTTP_SIGNATURE_POSTGRES_INGEST_WORKER; STRIPE_TRANSPORT_SIMULATED", reservationCount: 1, feeCount: 1,
      guestPaidCents: 10000, pinAIFeeReturnedCents: appFeeReturned, duplicateWebhookSuppressed: true }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.$disconnect();
    // The CI database is disposable. Do not delete shared or production records.
  }
});
