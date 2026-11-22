import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { prisma } from "../lib/prisma";
import { directDiscountsRouter } from "../routes/dashboard.direct-discounts.routes";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";
import { calculateDiscountedDirectQuote } from "./direct-booking-discounted-quote.service";
import { defaultDiscountConfig, type DiscountConfig } from "./direct-booking-discounts.policy";
import { validatePaidPricingSnapshot } from "./direct-booking-pricing-snapshot.policy";

const enabled = process.env.DIRECT_DISCOUNTS_DB_TEST === "true";
test("PostgreSQL: settings, preview, subtotal pricing and paid snapshot retention", { skip: !enabled, timeout: 60000 }, async t => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.equal(url.pathname, "/pingo_discounts_test", "Only a disposable test database is allowed");
  process.env.CI = "true"; process.env.NODE_ENV = "test";
  const org = await prisma.organization.create({ data: { name: "Synthetic discount certification" } });
  const otherOrg = await prisma.organization.create({ data: { name: "Synthetic other tenant" } });
  const property = await prisma.property.create({ data: { organizationId: org.id, name: "Synthetic discounts only", timezone: "America/Puerto_Rico",
    baseNightlyRate: 100, cleaningFee: 75, dynamicPricingEnabled: false, checkInTime: "16:00", checkOutTime: "11:00",
    amenities: { create: { name: "Required amenity", chargeMode: "REQUIRED", feeType: "PER_STAY", amount: 25 } },
    taxes: { create: { name: "Test tax", percentage: 7 } },
  } });
  let orgId = org.id;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: "synthetic-admin", orgId, role: "ORG_ADMIN" }; next(); });
  app.use(directDiscountsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const call = async (method: string, body?: unknown, suffix = "") => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/properties/${property.id}/direct-discounts${suffix}`, {
      method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const checkIn = new Date(); checkIn.setUTCDate(checkIn.getUTCDate() + 60); checkIn.setUTCHours(20, 0, 0, 0);
  const checkOut = new Date(checkIn); checkOut.setUTCDate(checkOut.getUTCDate() + 7); checkOut.setUTCHours(15, 0, 0, 0);
  const dates = { checkIn: checkIn.toISOString().slice(0, 10), checkOut: checkOut.toISOString().slice(0, 10) };
  const input = { propertyId: property.id, checkIn, checkOut, includeAuditEntries: false };
  const config: DiscountConfig = { ...defaultDiscountConfig, enabled: true, combination: "STACK", rules: [
    { id: "early", enabled: true, type: "EARLY_BIRD", threshold: 30, percent: 10, bookingFrom: null, bookingTo: null, stayFrom: null, stayTo: null, excludedDates: [] },
    { id: "long", enabled: true, type: "LENGTH_OF_STAY", threshold: 7, percent: 5, bookingFrom: null, bookingTo: null, stayFrom: null, stayTo: null, excludedDates: [] },
  ] };
  try {
    await t.test("migration creates expected tables and defaults stay disabled", async () => {
      const response = await call("GET"); assert.equal(response.status, 200); assert.equal(response.body.config.enabled, false); assert.equal(response.body.version, 0);
      assert.equal(await prisma.directBookingPricingSnapshot.count({ where: { propertyId: property.id } }), 0);
    });
    await t.test("preview evaluates unsaved rules without writing configuration", async () => {
      const response = await call("POST", { config, ...dates }, "/preview");
      assert.equal(response.status, 200); assert.equal(response.body.pricing.totalAmountCents, 74740);
      assert.equal(await prisma.directBookingDiscountConfig.count({ where: { propertyId: property.id } }), 0);
    });
    await t.test("save and reload preserve full configuration and tenant isolation", async () => {
      const saved = await call("PUT", { config, version: 0 }); assert.equal(saved.status, 200);
      const loaded = await call("GET"); assert.deepEqual(loaded.body.config, config); assert.equal(loaded.body.version, 1);
      orgId = otherOrg.id; assert.equal((await call("GET")).status, 404); orgId = org.id;
    });
    let paidPricing: Awaited<ReturnType<typeof calculateDiscountedDirectQuote>>;
    await t.test("discount applies to accommodation only with dynamic pricing off or on", async () => {
      for (const dynamicPricingEnabled of [false, true]) {
        await prisma.property.update({ where: { id: property.id }, data: { dynamicPricingEnabled } });
        const raw = await calculateDirectBookingPricing(input);
        const quote = await calculateDiscountedDirectQuote(input); paidPricing = quote;
        assert.equal(raw.nightlySubtotal, 700); assert.deepEqual(quote.nightlyRates.map(({ date, rate }) => ({ date, rate })), raw.nightlyRates.map(({ date, rate }) => ({ date, rate })));
        assert.equal(quote.accommodationDiscountTotal, 101.5); assert.equal(quote.accommodationSubtotalAfterDiscount, 598.5);
        assert.equal(quote.cleaningFee, 75); assert.equal(quote.amenitiesTotal, 25); assert.equal(quote.taxesTotal, 48.9); assert.equal(quote.totalAmountCents, 74740);
      }
    });
    await t.test("concurrent edits allow one version winner", async () => {
      const responses = await Promise.all([call("PUT", { config, version: 1 }), call("PUT", { config, version: 1 })]);
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    });
    await t.test("stored payment evidence survives configuration changes and repeated validation", async () => {
      const saved = await prisma.directBookingPricingSnapshot.create({ data: { propertyId: property.id, checkIn, checkOut, pricing: JSON.parse(JSON.stringify(paidPricing!)) } });
      await prisma.directBookingDiscountConfig.update({ where: { propertyId: property.id }, data: { config: defaultDiscountConfig } });
      assert.equal((await calculateDiscountedDirectQuote(input)).totalAmountCents, 85600);
      const original = await prisma.directBookingPricingSnapshot.findUniqueOrThrow({ where: { id: saved.id } });
      for (let attempt = 0; attempt < 2; attempt++) {
        const verified = validatePaidPricingSnapshot(original, { propertyId: property.id, checkIn, checkOut, amountTotal: 74740, currency: "usd" });
        assert.equal(verified.totalAmountCents, 74740);
        assert.equal((verified as typeof paidPricing).accommodationDiscountTotal, 101.5);
      }
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.directBookingPricingSnapshot.deleteMany({ where: { propertyId: property.id } });
    await prisma.property.delete({ where: { id: property.id } });
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } });
    await prisma.$disconnect();
  }
});
