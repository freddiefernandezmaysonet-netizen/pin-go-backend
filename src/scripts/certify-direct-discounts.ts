import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { defaultDiscountConfig } from "../services/direct-booking-discounts.policy.js";

// Dedicated certification service only; never mount this harness in the API.
assert.equal(process.env.RAILWAY_SERVICE_ID, "4cfd2dfd-3664-4bc6-b5cf-7ca765092f7a");
assert.equal(process.env.RAILWAY_ENVIRONMENT_ID, "9833f06b-463f-4551-bda7-a9a1eaaa9aa6");
const database = new URL(process.env.DATABASE_URL!);
assert.equal(database.hostname, "pin-ai-hybrid-e2e-db.railway.internal");
assert.equal(database.searchParams.get("schema"), "direct_discounts_certification");
assert.match(process.env.STRIPE_SECRET_KEY ?? "", /^(sk|rk)_test_/);
for (const key of ["RESEND_API_KEY", "TWILIO_AUTH_TOKEN", "CHANNEX_API_KEY", "TTLOCK_ACCESS_TOKEN", "OPENAI_API_KEY"])
  assert.ok(!process.env[key], `External operations credential prohibited: ${key}`);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2023-10-16", timeout: 20000 });
assert.equal((await stripe.accounts.retrieve()).id, "acct_1SmdRdRzkK1jKKf3");
const connectedAccountId = "acct_1UPbUgRqmXnirYx7";
const host = await stripe.accounts.retrieve(connectedAccountId);
assert.equal(host.metadata.synthetic, "true"); assert.equal(host.charges_enabled, true);
const db = new PrismaClient();
const run = `discount-cert-${randomUUID()}`;
const report = (data: Record<string, unknown>) => console.log(JSON.stringify({ message: "DIRECT_DISCOUNTS_CERTIFICATION", run, ...data }));
const domain = process.env.CERT_PUBLIC_URL!;
assert.match(domain, /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/);
const app = express(); let sessionId = "", endpointId = "", finished = false;
app.get("/ready", (_req, res) => res.json({ ready: Boolean(sessionId) }));
app.get("/booking/success", (_req, res) => res.type("text").send("Pago de prueba recibido. Estamos verificando la reserva y el descuento."));
app.get("/booking/cancel", (_req, res) => res.type("text").send("Pago de prueba cancelado."));
const server = app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
async function finish(failed = false) {
  if (finished) return; finished = true;
  if (sessionId) {
    const s = await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: connectedAccountId });
    if (s.status === "open") await stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount: connectedAccountId });
  }
  if (endpointId) await stripe.webhookEndpoints.del(endpointId);
  await db.$disconnect();
  report({ stage: "STOPPED", failed });
  server.close(() => process.exit(failed ? 1 : 0));
}
process.on("SIGTERM", () => void finish());
setTimeout(() => void finish(true), 55 * 60 * 1000).unref();
try {
  const org = await db.organization.create({ data: { name: "Synthetic discount certification", slug: run, publicBookingEnabled: true, stripeConnectAccountId: connectedAccountId } });
  const property = await db.property.create({ data: { organizationId: org.id, name: "PRUEBA Pin&Go descuentos", slug: run, isPublicBookable: true,
    baseNightlyRate: 100, cleaningFee: 75, minimumNights: 1, timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00",
    amenities: { create: { name: "Amenidad de prueba", chargeMode: "REQUIRED", feeType: "PER_STAY", amount: 25 } },
    taxes: { create: { name: "Impuesto de prueba", percentage: 7 } } } });
  await db.propertyGuestAgreement.create({ data: { propertyId: property.id, version: "synthetic-v1", title: "Synthetic", agreementText: "Synthetic test", requiresIdentityVerification: false, requiresAgreementSignature: false } });
  const rules = [{ id: "early", type: "EARLY_BIRD", threshold: 30, percent: 10 }, { id: "long", type: "LENGTH_OF_STAY", threshold: 7, percent: 5 }].map(r => ({ ...r, enabled: true, bookingFrom: null, bookingTo: null, stayFrom: null, stayTo: null, excludedDates: [] }));
  await db.directBookingDiscountConfig.create({ data: { propertyId: property.id, config: { ...defaultDiscountConfig, enabled: true, combination: "STACK", rules }, version: 1 } });
  const endpoint = await stripe.webhookEndpoints.create({ url: domain + "/webhooks/stripe", connect: true, enabled_events: ["checkout.session.completed", "checkout.session.async_payment_succeeded"], api_version: "2023-10-16", metadata: { synthetic: "true", run } });
  endpointId = endpoint.id; assert.ok(endpoint.secret); process.env.STRIPE_WEBHOOK_SECRET = endpoint.secret;
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res, next) => {
    try {
      const event = stripe.webhooks.constructEvent(req.body, String(req.headers["stripe-signature"] ?? ""), endpoint.secret!);
      const s = event.data.object as Stripe.Checkout.Session;
      if (event.livemode || event.account !== connectedAccountId || s.metadata?.organizationId !== org.id || s.metadata?.propertyId !== property.id)
        return void res.status(200).json({ ignored: true });
      report({ stage: "STRIPE_DELIVERY", eventId: event.id }); next();
    } catch { res.status(400).send("INVALID_SIGNATURE"); }
  });
  const { registerStripeWebhook } = await import("../webhooks/stripe.webhook.js");
  registerStripeWebhook(app);
  const { default: router } = await import("../routes/public-booking.routes.js");
  app.use(express.json()); app.use("/api/public-booking", router);
  const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/public-booking/create-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId: property.id, checkIn: "2030-01-02", checkOut: "2030-01-09", guestName: "Synthetic discount guest", guestEmail: "synthetic@example.com", preferredLanguage: "es", adults: 1, children: 0, guestAcceptedCancellationTerms: true, guestAcceptedSecurePreCheckinRequirement: true, expectedTotalAmountCents: 74740 }) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  sessionId = result.sessionId; assert.match(sessionId, /^cs_test_/);
  const session = await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: connectedAccountId });
  assert.equal(session.amount_total, 74740); assert.equal(session.livemode, false);
  // Changing current rules must not change the already-issued payment snapshot.
  await db.directBookingDiscountConfig.update({ where: { propertyId: property.id }, data: { config: defaultDiscountConfig } });
  report({ stage: "AWAITING_TEST_PAYMENT", checkoutUrl: result.checkoutUrl, sessionId, amountCents: session.amount_total });
  const poll = setInterval(async () => {
    if (finished) return;
    try {
      const reservation = await db.reservation.findUnique({ where: { stripeCheckoutSessionId: sessionId } });
      if (!reservation) return;
      assert.equal(reservation.paymentState, "PAID"); assert.equal(Number(reservation.totalAmount), 747.4);
      const pricing = reservation.pricingBreakdown as any;
      assert.equal(pricing.accommodationDiscountTotal, 101.5); assert.equal(pricing.accommodationSubtotalAfterDiscount, 598.5);
      assert.equal(pricing.cleaningFee, 75); assert.equal(pricing.amenitiesTotal, 25);
      const paid = await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: connectedAccountId });
      assert.equal(paid.payment_status, "paid");
      const { handleDirectBookingCheckoutCompleted } = await import("../services/direct-booking.service.js");
      await handleDirectBookingCheckoutCompleted(paid);
      assert.equal(await db.reservation.count({ where: { stripeCheckoutSessionId: sessionId } }), 1);
      report({ stage: "CERTIFIED", reservationId: reservation.id, totalCents: 74740, discountCents: 10150, reservationCount: 1 });
      clearInterval(poll); await finish();
    } catch (error) { clearInterval(poll); report({ stage: "FAILED", reason: error instanceof Error ? error.message.slice(0, 300) : "Unknown" }); await finish(true); }
  }, 3000);
} catch (error) { report({ stage: "FAILED", reason: error instanceof Error ? error.message.slice(0, 300) : "Unknown" }); await finish(true); }
