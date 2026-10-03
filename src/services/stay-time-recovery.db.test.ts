import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { runStayTimeRecoveryBatch } from "./stay-time-recovery.service.js";
import type { StayTimePaymentFlowDependencies } from "./stay-time-payment-flow.service.js";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("durable stay-time worker claims, crash recovery and bounded retries", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  t.after(() => db.$disconnect());
  for (const scenario of ["reconcile", "concurrent", "crashed-lease", "active-lease", "backoff", "scope"] as const) {
    await t.test(scenario, async () => {
      let now = new Date("2026-10-03T10:00Z");
      const old = new Date(now.getTime() - 120_000);
      const org = await db.organization.create({ data: { name: "Synthetic recovery" } });
      const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic recovery", timezone: "America/Puerto_Rico" } });
      const r = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic recovery",
        checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T16:00Z") } });
      let calls = 0;
      const deps: StayTimePaymentFlowDependencies = { client: db, now: () => now,
        retrievePayment: async () => { throw new Error("unexpected payment retrieval"); },
        ensureRefund: async () => { throw new Error("unexpected refund"); },
        reconcile: async id => {
          assert.equal(id, r.id); calls++;
          if (scenario === "concurrent") await new Promise(resolve => setTimeout(resolve, 100));
          if (scenario === "backoff" && calls === 1) throw new Error("synthetic unavailable reconciliation");
        },
      };
      try {
        const m = await db.reservationModification.create({ data: {
          reservationId: r.id, clientRequestId: "synthetic", requestFingerprint: "synthetic", status: "APPLIED",
          financialAction: "NO_PAYMENT_REQUIRED", requestSource: "PIN_AI_GUEST_SERVICES", baseReservationUpdatedAt: r.updatedAt,
          currentCheckIn: r.checkIn, currentCheckOut: new Date("2026-10-03T15:00Z"), proposedCheckIn: r.checkIn, proposedCheckOut: r.checkOut,
          currentAdults: 1, currentChildren: 0, proposedAdults: 1, proposedChildren: 0,
          currentPricing: {}, proposedPricing: {}, currentTotalAmount: 100, proposedTotalAmount: 100, amountDifference: 0,
          guestConfirmation: { operation: "LATE_CHECKOUT" }, appliedAt: old, updatedAt: old,
          ...(scenario === "active-lease" ? { stayTimeRecoveryLeaseToken: "other", stayTimeRecoveryLeaseUntil: new Date(now.getTime() + 60_000) } : {}),
          ...(scenario === "crashed-lease" ? { stayTimeRecoveryLeaseToken: "crashed", stayTimeRecoveryLeaseUntil: old } : {}),
        } });
        if (scenario === "scope") {
          await db.reservationModification.update({ where: { id: m.id }, data: { requestSource: "GUEST_MANAGE_RESERVATION", updatedAt: old } });
          assert.equal((await runStayTimeRecoveryBatch(deps)).processed, 0);
          await db.reservationModification.update({ where: { id: m.id }, data: { requestSource: "PIN_AI_GUEST_SERVICES", guestConfirmation: { operation: "EXTEND_CHECKOUT_ONLY" }, updatedAt: old } });
          assert.equal((await runStayTimeRecoveryBatch(deps)).processed, 0);
          await db.reservationModification.update({ where: { id: m.id }, data: { guestConfirmation: { operation: "LATE_CHECKOUT" }, status: "AWAITING_PAYMENT", updatedAt: old } });
          assert.equal((await runStayTimeRecoveryBatch(deps)).processed, 0);
          assert.equal(calls, 0);
          return;
        }
        const batches = scenario === "concurrent" ? await Promise.all([runStayTimeRecoveryBatch(deps), runStayTimeRecoveryBatch(deps)]) : [await runStayTimeRecoveryBatch(deps)];
        assert.equal(batches.reduce((n, b) => n + b.processed, 0), scenario === "active-lease" ? 0 : 1);
        if (scenario === "active-lease") { assert.equal(calls, 0); return; }
        let saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
        assert.equal(saved.stayTimeRecoveryLeaseToken, null);
        assert.equal(saved.stayTimeRecoveryAttempts, 1);
        if (scenario === "backoff") {
          assert.equal(saved.stayTimeReconciledAt, null);
          assert.equal(saved.stayTimeRecoveryNextAt?.getTime(), now.getTime() + 60_000);
          assert.equal((await runStayTimeRecoveryBatch(deps)).processed, 0);
          now = saved.stayTimeRecoveryNextAt!;
          assert.equal((await runStayTimeRecoveryBatch(deps)).results[0].outcome, "APPLIED");
          saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
          assert.equal(saved.stayTimeRecoveryAttempts, 2);
        }
        assert.ok(saved.stayTimeReconciledAt);
        assert.equal(saved.stayTimeRecoveryNextAt, null);
        now = new Date(now.getTime() + 3_600_000);
        assert.equal((await runStayTimeRecoveryBatch(deps)).processed, 0, "completed reconciliation must leave the queue");
        assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: r.id } }), r);
        await assert.rejects(runStayTimeRecoveryBatch(deps, 0), /LIMIT_INVALID/);
      } finally {
        await db.reservationModification.deleteMany({ where: { reservationId: r.id } });
        await db.reservation.delete({ where: { id: r.id } });
        await db.property.delete({ where: { id: property.id } });
        await db.organization.delete({ where: { id: org.id } });
      }
    });
  }
});
