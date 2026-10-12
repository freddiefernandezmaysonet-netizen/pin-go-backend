import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { PIN_AI_HYBRID_BILLING_TERMS as TERMS } from "./billing-terms.js";
import { capturePinAIReservationService } from "./reservation-service-evidence.js";
import { captureDirectPinAIFee, directPinAIFeeSnapshot } from "./hybrid-fee-evidence.service.js";
import { settleHybridFee, hybridFeeOperationKey } from "./hybrid-fee.service.js";
import type { HybridFeeProvider } from "./hybrid-fee-stripe.provider.js";
const enabled = process.env.PIN_AI_HYBRID_DB_TEST === "true";
const url = new URL(process.env.DATABASE_URL ?? "http://missing");
if (enabled && (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/pin_ai_activation_test"))
  throw Error("Hybrid fee tests require isolated local database");
test("hybrid fee intake, persisted retries, concurrent settlement and cancellation", { skip: !enabled }, async t => {
  const db = new PrismaClient(); const now = new Date("2030-01-01T12:00:00Z");
  const org = await db.organization.create({ data: { name: "Synthetic hybrid", pinAIEnabled: true, pinAIRevision: 1 } });
  const p = await db.property.create({ data: { name: "Synthetic hybrid", organizationId: org.id,
    pinAIEnabled: true, pinAIRevision: 1, pinAITermsVersion: TERMS.version,
    pinAITermsAcceptedAt: new Date(+now - 1000), pinAITermsAcceptedBy: "synthetic-host" } });
  const env = { PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
    PIN_AI_HYBRID_BILLING_ENABLED: "true", PIN_AI_HYBRID_BILLING_ORGANIZATION_IDS: org.id };
  let creates = 0, reversals = 0, itemPaid = false, loseCreate = false, loseReversal = false;
  const operations = new Map<string, string>();
  const provider: HybridFeeProvider = {
    validateMembership: async () => true,
    createItem: async (_fee, key) => {
      if (!operations.has(key)) { creates++; operations.set(key, `ii_${creates}`); }
      if (loseCreate) { loseCreate = false; throw Error("lost response"); }
      return { id: operations.get(key)! };
    },
    itemState: async () => ({ invoiceId: itemPaid ? "in_membership" : null, paid: itemPaid }),
    directEvidence: async () => "fee_direct",
    reversalPlan: async f => f.collectionMethod === "MEMBERSHIP"
      ? { kind: "DELETE_ITEM", itemId: f.stripeInvoiceItemId! }
      : { kind: "APPLICATION_FEE_REFUND", feeId: "fee_direct", amount: 100, target: 100 },
    reverse: async (_fee, _request, key) => {
      if (!operations.has(key)) { reversals++; operations.set(key, `fr_${reversals}`); }
      if (loseReversal) { loseReversal = false; throw Error("lost response"); }
      return operations.get(key)!;
    },
    reconcile: async (_fee, _op, key) => operations.get(key) ?? null,
  };
  const create = async (source = "Airbnb", capture = true, status: "ACTIVE" | "CANCELLED" = "ACTIVE") => db.$transaction(async tx => {
    const r = await tx.reservation.create({ data: { propertyId: p.id, guestName: "Synthetic", source,
      externalProvider: source === "Airbnb" ? "CHANNEX" : null, status,
      checkIn: new Date(+now + 30 * 86400000), checkOut: new Date(+now + 32 * 86400000) } });
    if (capture) await capturePinAIReservationService(tx, r.id, env, now, true);
    return r;
  });
  const resetDue = (id: string) => db.pinAIReservationFee.update({ where: { reservationId: id }, data: { exportNextAttemptAt: null } });
  const settle = (id: string, at = now) => settleHybridFee(db, provider, env, id, at);
  try {
    await t.test("future OTA accrues at intake and repeated intake never duplicates", async () => {
      const r = await create(); const f = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: r.id } });
      assert.equal(f.amountCents, 100); assert.equal(f.billingStatus, "PENDING_MEMBERSHIP"); assert.equal(+f.recordedAt, +now);
      assert.equal(await db.$transaction(tx => capturePinAIReservationService(tx, r.id, env, now, true)), "ALREADY_RECORDED");
      assert.equal(await settle(r.id), "PENDING_MEMBERSHIP", "membership can be added later; no card charge fallback");
    });
    await db.subscription.create({ data: { organizationId: org.id, status: "ACTIVE", stripeCustomerId: "cus_host", stripeSubscriptionId: "sub_membership" } });
    await t.test("manual reservation uses membership; updates and initially cancelled OTA do not accrue", async () => {
      const manual = await create("MANUAL"); assert.equal(await settle(manual.id), "ON_MEMBERSHIP");
      const old = await create("Airbnb", false);
      assert.equal(await db.$transaction(tx => capturePinAIReservationService(tx, old.id, env, now)), "NOT_ELIGIBLE");
      assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: old.id } }), 0);
      const cancelled = await create("Airbnb", true, "CANCELLED");
      assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: cancelled.id } }), 0);
    });
    await t.test("exempt and legacy consent cannot create a hybrid obligation or checkout dollar", async () => {
      await db.property.update({ where: { id: p.id }, data: { pinAIFeeExempt: true } });
      const exempt = await create(); assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: exempt.id } }), 0);
      assert.deepEqual(await directPinAIFeeSnapshot(db, env, p.id, org.id, now), {});
      await db.property.update({ where: { id: p.id }, data: { pinAIFeeExempt: false, pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1" } });
      const legacy = await create(); assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: legacy.id } }), 0);
      await db.property.update({ where: { id: p.id }, data: { pinAITermsVersion: TERMS.version } });
    });
    await t.test("reservation and fee roll back together", async () => {
      let id = "";
      await assert.rejects(db.$transaction(async tx => {
        const r = await tx.reservation.create({ data: { propertyId: p.id, guestName: "Rollback", checkIn: now, checkOut: new Date(+now + 86400000) } });
        id = r.id; await capturePinAIReservationService(tx, id, env, now, true); throw Error("rollback");
      }), /rollback/);
      assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: id } }), 0);
    });
    await t.test("concurrent workers own one Stripe operation and invoice payment is reconciled", async () => {
      const r = await create(); const before = creates;
      const result = await Promise.all([settle(r.id), settle(r.id)]);
      assert.ok(result.includes("ON_MEMBERSHIP")); assert.equal(creates, before + 1);
      itemPaid = true; await resetDue(r.id); assert.equal(await settle(r.id), "PAID"); itemPaid = false;
    });
    await t.test("cancellation before export has no external operation", async () => {
      const r = await create(); const before = creates;
      await db.reservation.update({ where: { id: r.id }, data: { status: "CANCELLED" } });
      assert.equal(await settle(r.id), "REVERSED"); assert.equal(creates, before);
    });
    await t.test("lost create response followed by cancellation recovers then removes the item once", async () => {
      const r = await create(); loseCreate = true; const before = creates;
      assert.equal(await settle(r.id), "RETRY"); assert.equal(creates, before + 1);
      await db.reservation.update({ where: { id: r.id }, data: { status: "CANCELLED" } });
      await resetDue(r.id); loseReversal = true; assert.equal(await settle(r.id), "RETRY");
      const reversedBefore = reversals; await resetDue(r.id);
      assert.equal(await settle(r.id), "REVERSED"); assert.equal(reversals, reversedBefore); assert.equal(creates, before + 1);
    });
    await t.test("after idempotency retention only GET reconciliation is allowed", async () => {
      const r = await create(); loseCreate = true; await settle(r.id); const before = creates;
      await resetDue(r.id); assert.equal(await settle(r.id, new Date(+now + 25 * 3600000)), "ON_MEMBERSHIP");
      assert.equal(creates, before);
      const missing = await create(); await db.pinAIReservationFee.update({ where: { reservationId: missing.id }, data: { exportStartedAt: now } });
      assert.equal(await settle(missing.id, new Date(+now + 25 * 3600000)), "NEEDS_REVIEW"); assert.equal(creates, before);
    });
    await t.test("direct checkout snapshot persists one paid obligation and never creates a membership item", async () => {
      const r = await create("DIRECT_BOOKING"); assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: r.id } }), 0);
      await db.reservation.update({ where: { id: r.id }, data: { stripePaymentIntentId: "pi_guest", stripeConnectedAccountId: "acct_host" } });
      const metadata = { ...await directPinAIFeeSnapshot(db, env, p.id, org.id, now), propertyId: p.id, organizationId: org.id };
      await captureDirectPinAIFee(db, r.id, metadata, now); await captureDirectPinAIFee(db, r.id, metadata, now);
      const before = creates; assert.equal(await settle(r.id), "PAID"); assert.equal(creates, before);
      await db.reservation.update({ where: { id: r.id }, data: { status: "CANCELLED" } }); await resetDue(r.id);
      assert.equal(await settle(r.id), "REVERSED");
    });
    await t.test("out-of-scope org cannot collect; exact operation key is stable", async () => {
      const r = await create(); assert.equal(await settleHybridFee(db, provider, { ...env, PIN_AI_HYBRID_BILLING_ORGANIZATION_IDS: "other" }, r.id, now), "DISABLED");
      assert.equal(hybridFeeOperationKey(r.id, "item"), hybridFeeOperationKey(r.id, "item"));
    });
  } finally {
    await db.pinAIReservationFee.deleteMany({ where: { organizationId: org.id } });
    await db.reservation.deleteMany({ where: { propertyId: p.id } });
    await db.subscription.deleteMany({ where: { organizationId: org.id } });
    await db.property.delete({ where: { id: p.id } }); await db.organization.delete({ where: { id: org.id } }); await db.$disconnect();
  }
});
