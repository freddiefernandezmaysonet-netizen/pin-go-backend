import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { PIN_AI_HYBRID_BILLING_TERMS as TERMS } from "../pin-ai/billing-terms.js";

const project = "84db0f26-4fd1-413b-bcc5-c5b7014f3a9c";
const environment = "9833f06b-463f-4551-bda7-a9a1eaaa9aa6";
const connectedAccountId = "acct_1UPbUgRqmXnirYx7";
assert.equal(process.env.RAILWAY_PROJECT_ID, project);
assert.equal(process.env.RAILWAY_ENVIRONMENT_ID, environment);
assert.ok(Date.now() < Date.parse(process.env.PIN_AI_E2E_EXPIRES_AT ?? ""), "Certification expired");
const dbUrl = new URL(process.env.DATABASE_URL ?? "http://missing");
assert.equal(dbUrl.hostname, "pin-ai-hybrid-e2e-db.railway.internal");
assert.equal(dbUrl.pathname, "/pin_ai_hybrid_e2e");
assert.match(process.env.STRIPE_SECRET_KEY ?? "", /^(sk|rk)_test_\S+$/);
for (const key of ["RESEND_API_KEY", "TWILIO_AUTH_TOKEN", "CHANNEX_API_KEY", "TTLOCK_ACCESS_TOKEN", "OPENAI_API_KEY"])
  assert.ok(!process.env[key], `External operations credential prohibited: ${key}`);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2023-10-16", maxNetworkRetries: 0, timeout: 30000 });
assert.equal((await stripe.accounts.retrieve()).id, "acct_1SmdRdRzkK1jKKf3");
const account = await stripe.accounts.retrieve(connectedAccountId);
assert.equal(account.metadata?.synthetic, "true"); assert.equal(account.charges_enabled, true);
assert.equal(account.controller?.losses?.payments, "stripe"); assert.equal(account.controller?.fees?.payer, "account");

const run = `qa-pin-ai-hybrid-live-${randomUUID()}`;
const report = (data: Record<string, unknown>) => console.log(JSON.stringify({ certificate: "PIN_AI_HYBRID_LIVE", run, ...data }));
const db = new PrismaClient();
let orgId = "", propertyId = "", endpointId = "", sessionId = "", worker: ChildProcess | undefined;
let receipt: Record<string, unknown> | undefined;
let finishing = false;
const domain = String(process.env.PIN_AI_E2E_PUBLIC_URL ?? "");
assert.match(domain, /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/);
const app = express();
app.get("/ready", (_req, res) => res.json({ ready: Boolean(sessionId), run, certified: receipt?.certified === true }));
const server = app.listen(Number(process.env.PORT ?? "3000"), "0.0.0.0");
const org = await db.organization.create({ data: { name: "Synthetic hybrid live certification", slug: run,
  publicBookingEnabled: true, pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: connectedAccountId } });
orgId = org.id;
const property = await db.property.create({ data: { name: "Synthetic hybrid live certification", organizationId: org.id,
  isPublicBookable: true, baseNightlyRate: 100, minimumNights: 1, timezone: "UTC", checkInTime: "16:00", checkOutTime: "11:00",
  pinAIEnabled: true, pinAIRevision: 1, pinAITermsVersion: TERMS.version,
  pinAITermsAcceptedAt: new Date(Date.now() - 60000), pinAITermsAcceptedBy: "synthetic-host" } });
propertyId = property.id;
await db.propertyGuestAgreement.create({ data: { propertyId, version: "synthetic-v1", title: "Synthetic",
  agreementText: "Synthetic sandbox agreement", requiresIdentityVerification: false, requiresAgreementSignature: false } });
process.env.PIN_AI_PROPERTY_ACTIVATION_ENABLED = "true";
process.env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED = "true";
process.env.PIN_AI_HYBRID_BILLING_ENABLED = "true";
process.env.PIN_AI_HYBRID_BILLING_ORGANIZATION_IDS = org.id;
process.env.RESERVATION_WORKER_POLL_MS = "10000";

async function cleanup() {
  if (worker && worker.exitCode === null) worker.kill("SIGTERM");
  if (endpointId) {
    try { await stripe.webhookEndpoints.del(endpointId); endpointId = ""; }
    catch { report({ cleanupPending: "webhook_endpoint" }); }
  }
  if (sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: connectedAccountId });
      if (session.status === "open") await stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount: connectedAccountId });
      if (session.payment_status === "paid" && session.payment_intent) {
        const paymentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
        const pi = await stripe.paymentIntents.retrieve(paymentId, { expand: ["latest_charge"] }, { stripeAccount: connectedAccountId });
        assert.equal(pi.metadata.organizationId, orgId); assert.equal(pi.metadata.propertyId, propertyId);
        const charge = pi.latest_charge as Stripe.Charge;
        if (charge.amount_refunded < charge.amount) await stripe.refunds.create({ payment_intent: pi.id,
          amount: charge.amount - charge.amount_refunded, refund_application_fee: false },
        { stripeAccount: connectedAccountId, idempotencyKey: `${run}:guest-cleanup` });
        const feeId = typeof charge.application_fee === "string" ? charge.application_fee : charge.application_fee?.id;
        if (feeId) {
          const fee = await stripe.applicationFees.retrieve(feeId);
          if (fee.amount_refunded < fee.amount) await stripe.applicationFees.createRefund(feeId,
            { amount: fee.amount - fee.amount_refunded }, { idempotencyKey: `${run}:fee-cleanup` });
        }
      }
    } catch (error) { report({ cleanupPending: "checkout", error: error instanceof Error ? error.name : "UnknownError" }); }
  }
}

async function finish(error?: unknown) {
  if (finishing) return; finishing = true;
  if (error) report({ certified: false, stage: "FAILED", error: error instanceof Error ? error.message.slice(0,200) : "UnknownError" });
  await cleanup();
  report({ stage: "CLEANUP", workerStopped: true, webhookRemoved: !endpointId });
  await db.$disconnect();
  setTimeout(() => server.close(() => process.exit(error ? 1 : 0)), 30000);
}
process.on("SIGTERM", () => void finish(Error("CERTIFICATION_TERMINATED")));
process.on("SIGINT", () => void finish(Error("CERTIFICATION_TERMINATED")));

try {
  const endpoint = await stripe.webhookEndpoints.create({ url: `${domain}/webhooks/stripe`, connect: true,
    enabled_events: ["checkout.session.completed"], api_version: "2023-10-16", metadata: { synthetic: "true", run } },
  { idempotencyKey: `${run}:endpoint` });
  endpointId = endpoint.id; assert.ok(endpoint.secret); process.env.STRIPE_WEBHOOK_SECRET = endpoint.secret;
  // The secret remains in process memory and is never printed or copied to files.
  const { registerStripeWebhook } = await import("../webhooks/stripe.webhook.js");
  app.post("/webhooks/stripe", bodyParser.raw({ type: "application/json" }), (req, res, next) => {
    try {
      const event = stripe.webhooks.constructEvent(req.body, String(req.headers["stripe-signature"] ?? ""), endpoint.secret!);
      const object = event.data.object as Stripe.Checkout.Session;
      if (event.livemode || event.account !== connectedAccountId || object.metadata?.organizationId !== orgId || object.metadata?.propertyId !== propertyId)
        return void res.status(200).json({ ignored: "OUTSIDE_SYNTHETIC_SCOPE" });
      report({ stage: "STRIPE_DELIVERY", eventId: event.id, sessionId: object.id, livemode: event.livemode });
      next();
    } catch { res.status(400).json({ error: "INVALID_SIGNATURE" }); }
  });
  registerStripeWebhook(app);
  const { default: router } = await import("../routes/public-booking.routes.js");
  app.use(express.json()); app.use("/api/public-booking", router);
  const checkout = await fetch(`http://127.0.0.1:${process.env.PORT ?? "3000"}/api/public-booking/create-checkout`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId, checkIn: "2030-01-02", checkOut: "2030-01-03",
      guestName: "Synthetic test guest", guestEmail: "synthetic@example.com", preferredLanguage: "es", adults: 1, children: 0,
      guestAcceptedCancellationTerms: true, guestAcceptedSecurePreCheckinRequirement: true }) });
  const result = await checkout.json(); assert.equal(checkout.status, 200, JSON.stringify(result));
  sessionId = result.sessionId; assert.ok(sessionId.startsWith("cs_test_")); assert.equal(result.totalAmount, 100);
  worker = spawn(process.execPath, ["--import", "tsx", "src/workers/reservation.worker.ts"], { env: { ...process.env }, stdio: "inherit" });
  report({ stage: "AWAITING_TEST_CHECKOUT", checkoutUrl: result.checkoutUrl, sessionId, workerPid: worker.pid,
    webhookEndpointId: endpointId, guestAmountCents: 10000, connectedAccountId });
  const deadline = Math.min(Date.now() + 30 * 60000, Date.parse(process.env.PIN_AI_E2E_EXPIRES_AT!));
  while (Date.now() < deadline && !finishing) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const reservation = await db.reservation.findUnique({ where: { stripeCheckoutSessionId: sessionId } });
    if (!reservation) continue;
    const fee = await db.pinAIReservationFee.findUnique({ where: { reservationId: reservation.id } });
    if (!fee || fee.billingStatus !== "PAID") continue;
    assert.equal(fee.amountCents, 100); assert.equal(fee.collectionMethod, "DIRECT_APPLICATION_FEE");
    assert.equal(Number(reservation.amountCollected), 100); assert.equal(reservation.paymentState, "PAID");
    report({ stage: "WORKER_COLLECTED", reservationId: reservation.id, billingStatus: fee.billingStatus, feeAmountCents: fee.amountCents });
    const refund = await stripe.refunds.create({ payment_intent: fee.stripePaymentIntentId!, refund_application_fee: false },
      { stripeAccount: connectedAccountId, idempotencyKey: `${run}:cancel-guest` });
    assert.equal(refund.status, "succeeded");
    await db.reservation.update({ where: { id: reservation.id }, data: { status: "CANCELLED", paymentState: "REFUNDED", amountRefunded: 100 } });
    await db.pinAIReservationFee.update({ where: { reservationId: reservation.id }, data: { exportNextAttemptAt: null } });
    const reversalDeadline = Date.now() + 150000;
    while (Date.now() < reversalDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const reversed = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: reservation.id } });
      if (reversed.billingStatus !== "REVERSED") continue;
      const applicationFee = await stripe.applicationFees.retrieve(reversed.stripeApplicationFeeId!);
      assert.equal(applicationFee.amount_refunded, applicationFee.amount);
      assert.equal(await db.reservation.count({ where: { stripeCheckoutSessionId: sessionId } }), 1);
      assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: reservation.id } }), 1);
      receipt = { certified: true, reservationId: reservation.id, sessionId, paymentIntentId: fee.stripePaymentIntentId,
        applicationFeeId: applicationFee.id, applicationFeeReturnedCents: applicationFee.amount_refunded, guestRefundId: refund.id,
        guestPaidCents: 10000, pinAIFeeReturnedCents: 100, reservationCount: 1, feeCount: 1,
        scope: "REAL_PUBLIC_HTTP_CHECKOUT_STRIPE_DELIVERY_POSTGRES_RESERVATION_WORKER_SCHEDULER" };
      report(receipt); await finish(); break;
    }
    assert.ok(receipt, "Worker did not reverse the fee within 150 seconds"); break;
  }
  if (!receipt && !finishing) await finish(Error("TEST_CHECKOUT_TIMEOUT"));
} catch (error) { await finish(error); }
