import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { runStayTimeRecoveryBatch } from "./stay-time-recovery.service.js";
import type { StayTimePaymentFlowDependencies } from "./stay-time-payment-flow.service.js";
import { resolveOperationalIssuesForReservation } from "../apms/operational-intelligence.service.js";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("durable stay-time worker claims, crash recovery and bounded retries", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  t.after(() => db.$disconnect());
  for (const scenario of ["reconcile", "concurrent", "crashed-lease", "active-lease", "backoff", "scope",
    "review-recovered", "review-concurrent", "review-webhook", "review-refund", "review-cancelled", "review-waiting", "review-expired",
    "review-ledger-outage", "review-stale-lease", "review-reservation-cancelled"] as const) {
    await t.test(scenario, async () => {
      let now = new Date("2026-10-03T10:00Z");
      const old = new Date(now.getTime() - 120_000);
      const org = await db.organization.create({ data: { name: "Synthetic recovery" } });
      const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic recovery", timezone: "America/Puerto_Rico" } });
      const r = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic recovery",
        checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T16:00Z") } });
      let calls = 0;
      let unavailable = scenario.startsWith("review-");
      let replaceLease = false;
      const deps: StayTimePaymentFlowDependencies = { client: db, now: () => now,
        retrievePayment: async () => { throw new Error("unexpected payment retrieval"); },
        ensureRefund: async () => { throw new Error("unexpected refund"); },
        reconcile: async id => {
          assert.equal(id, r.id); calls++;
          if (replaceLease) await db.reservationModification.updateMany({ where: { reservationId: r.id }, data: {
            updatedAt: now, stayTimeRecoveryLeaseToken: "new-worker", stayTimeRecoveryLeaseUntil: new Date(now.getTime() + 600_000) } });
          if (unavailable) throw new Error("synthetic private provider details must never be persisted");
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
        if (scenario.startsWith("review-")) {
          const key = `STAY_TIME_RECOVERY_REVIEW:${m.id}`;
          const awaiting = scenario === "review-waiting" || scenario === "review-expired";
          await db.reservationModification.update({ where: { id: m.id }, data: {
            stayTimeRecoveryAttempts: 4, updatedAt: old,
            ...(awaiting ? { status: "AWAITING_PAYMENT", financialAction: "ADDITIONAL_PAYMENT_REQUIRED",
              stripeConnectedAccountId: "acct_synthetic_review", stripeCheckoutSessionId: `cs_${m.id}`,
              checkoutExpiresAt: scenario === "review-waiting" ? new Date(now.getTime() + 3_600_000) : old } : {}),
          } });
          assert.equal((await runStayTimeRecoveryBatch(deps)).results[0].outcome, "RETRY_SCHEDULED");
          assert.equal(await db.operationalIssue.count({ where: { operationalKey: key } }), 0, "five attempts do not escalate");
          let saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
          now = saved.stayTimeRecoveryNextAt!;
          if (scenario === "review-ledger-outage") {
            deps.client = new Proxy(db, { get(target, key) {
              if (key !== "$transaction") return Reflect.get(target, key);
              return (async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(async tx => work(
                new Proxy(tx, { get(inner, field) {
                  if (field !== "operationalIssue") return Reflect.get(inner, field);
                  return new Proxy(inner.operationalIssue, { get(delegate, method) {
                    if (method === "upsert") return async () => { throw new Error("synthetic issue storage outage"); };
                    return Reflect.get(delegate, method);
                  } });
                } })
              ))) as typeof db.$transaction;
            } });
            await assert.rejects(runStayTimeRecoveryBatch(deps), /synthetic issue storage outage/);
            deps.client = db;
            saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
            assert.ok(saved.stayTimeRecoveryLeaseToken, "failed issue persistence must roll back lease release");
            assert.equal(saved.stayTimeRecoveryAttempts, 6);
            assert.equal(await db.operationalIssue.count({ where: { operationalKey: key } }), 0);
            now = saved.stayTimeRecoveryLeaseUntil!;
          }
          if (scenario === "review-stale-lease") {
            replaceLease = true;
            await runStayTimeRecoveryBatch(deps);
            saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
            assert.equal(saved.stayTimeRecoveryLeaseToken, "new-worker");
            assert.equal(await db.operationalIssue.count({ where: { operationalKey: key } }), 0, "a stale worker cannot escalate or release another claim");
            assert.equal((await runStayTimeRecoveryBatch(deps)).processed, 0);
            replaceLease = false;
            now = saved.stayTimeRecoveryLeaseUntil!;
          }
          const batches = await Promise.all([runStayTimeRecoveryBatch(deps), runStayTimeRecoveryBatch(deps)]);
          assert.equal(batches.reduce((n, b) => n + b.processed, 0), 1);
          if (scenario === "review-waiting") {
            assert.equal(await db.operationalIssue.count({ where: { operationalKey: key } }), 0, "normal Checkout waiting is not an operator failure");
            assert.equal((await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } })).status, "AWAITING_PAYMENT");
            return;
          }
          let issue = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: key } });
          assert.equal(issue.workflowState, "ACTION_REQUIRED"); assert.equal(issue.responsibleActor, "PIN_GO");
          assert.equal(issue.visibility, "DEVELOPER"); assert.equal(issue.organizationId, org.id);
          assert.equal(issue.propertyId, property.id); assert.equal(issue.reservationId, r.id);
          assert.equal(issue.severity, "CRITICAL"); assert.equal(issue.actionRequired, true);
          assert.equal(JSON.stringify(issue).includes("private provider details"), false);
          assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1);
          saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
          now = saved.stayTimeRecoveryNextAt!;
          await runStayTimeRecoveryBatch(deps);
          assert.equal(await db.operationalIssue.count({ where: { operationalKey: key } }), 1);
          assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1, "repeated failures do not duplicate transitions");
          if (scenario === "review-expired") {
            assert.equal((await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } })).status, "AWAITING_PAYMENT");
            assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: r.id } }), r);
            return;
          }
          if (scenario === "review-cancelled" || scenario === "review-reservation-cancelled") {
            await db.reservationModification.update({ where: { id: m.id }, data: { status: "CANCELLED" } });
            if (scenario === "review-reservation-cancelled") {
              await db.reservation.update({ where: { id: r.id }, data: { status: "CANCELLED" } });
              const result = await resolveOperationalIssuesForReservation(db, { reservationId: r.id,
                resolutionCode: "RESERVATION_CANCELLED", resolutionSummary: "Synthetic reservation cancellation",
                resolvedBy: "GUEST", sourceType: "ENGINE_EVENT", occurredAt: now });
              assert.equal(result.resolvedCount, 0, "generic reservation closure must retain unsettled recovery incidents");
            }
            await runStayTimeRecoveryBatch(deps);
            assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: key } })).workflowState, "ACTION_REQUIRED",
              "cancellation without settled payment evidence cannot close the incident");
            return;
          }
          unavailable = false;
          if (scenario === "review-webhook") {
            await db.reservationModification.update({ where: { id: m.id }, data: { stayTimeReconciledAt: now } });
          } else if (scenario === "review-refund") {
            await db.reservationModification.update({ where: { id: m.id }, data: { status: "CANCELLED", failureCode: "STAY_TIME_REFUNDED" } });
          } else {
            saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
            now = saved.stayTimeRecoveryNextAt!;
          }
          if (scenario === "review-concurrent") await Promise.all([runStayTimeRecoveryBatch(deps), runStayTimeRecoveryBatch(deps)]);
          else await runStayTimeRecoveryBatch(deps);
          issue = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: key } });
          assert.equal(issue.workflowState, "RESOLVED"); assert.equal(issue.actionRequired, false);
          assert.equal(issue.resolutionCode, scenario === "review-refund" ? "STAY_TIME_REFUNDED" : "STAY_TIME_RECONCILED");
          assert.equal((issue.metadata as { physicalAccessCertified: boolean }).physicalAccessCertified, false);
          assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 2);
          assert.equal((await runStayTimeRecoveryBatch(deps)).processed, 0);
          assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 2);
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: r.id } }), r);
          return;
        }
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
        await db.operationalIssueTransition.deleteMany({ where: { issue: { reservationId: r.id } } });
        await db.operationalIssue.deleteMany({ where: { reservationId: r.id } });
        await db.reservationModification.deleteMany({ where: { reservationId: r.id } });
        await db.reservation.delete({ where: { id: r.id } });
        await db.property.delete({ where: { id: property.id } });
        await db.organization.delete({ where: { id: org.id } });
      }
    });
  }
});
