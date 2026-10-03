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

test("verified abandoned Checkout expiry is atomic, fenced and never changes the reservation", { skip: !url }, async t => {
  const parsed = new URL(url!); assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname)); assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } }); t.after(() => db.$disconnect());
  const { syntheticStayTimePaymentEvidence } = await import("./stay-time-payment-evidence.fixture.js");
  for (const scenario of ["expired-unpaid", "already-expired", "no-incident", "concurrent", "intent-present", "provider-outage",
    "stale-evidence", "lost-lease", "expired-lease", "payment-race", "account-race", "journal-outage",
    "canceled-intent", "canceled-stored-intent", "canceled-processing", "canceled-charge", "canceled-intent-race",
    "canceled-lost-lease", "canceled-journal-outage"] as const) await t.test(scenario, async () => {
    let now = new Date("2026-10-03T15:00Z"); const old = new Date(now.getTime() - 120_000);
    const org = await db.organization.create({ data: { name: "Synthetic unpaid expiry" } });
    const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic unpaid expiry" } });
    const r = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic",
      checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-04T15:00Z"), stripeConnectedAccountId: "acct_expiry" } });
    try {
      const m = await db.reservationModification.create({ data: { reservationId: r.id, clientRequestId: "synthetic", requestFingerprint: "synthetic",
        status: scenario === "already-expired" ? "EXPIRED" : "AWAITING_PAYMENT", financialAction: "ADDITIONAL_PAYMENT_REQUIRED",
        requestSource: "PIN_AI_GUEST_SERVICES", baseReservationUpdatedAt: r.updatedAt, currentCheckIn: r.checkIn, currentCheckOut: r.checkOut,
        proposedCheckIn: r.checkIn, proposedCheckOut: new Date("2026-10-04T16:00Z"), currentAdults: 1, currentChildren: 0, proposedAdults: 1, proposedChildren: 0,
        currentPricing: {}, proposedPricing: {}, currentTotalAmount: 100, proposedTotalAmount: 120, amountDifference: 20,
        additionalChargeAmount: 20, additionalPlatformFeeAmount: 1, additionalHostPayoutAmount: 19,
        stripeConnectedAccountId: "acct_expiry", stripeCheckoutSessionId: `cs_${r.id}`, checkoutExpiresAt: old,
        stayTimeRecoveryAttempts: scenario === "no-incident" ? 0 : 5, guestConfirmation: { operation: "LATE_CHECKOUT" }, updatedAt: old } });
      const deps: import("./stay-time-recovery.service.js").StayTimeRecoveryDependencies = { client: db, now: () => now,
        retrievePayment: async () => { throw new Error("synthetic unpaid session"); },
        ensureRefund: async () => { throw new Error("must never refund"); }, reconcile: async () => { throw new Error("must never change access"); } };
      let issueId: string | undefined;
      if (scenario !== "no-incident") {
        await runStayTimeRecoveryBatch(deps);
        const issue = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: `STAY_TIME_RECOVERY_REVIEW:${m.id}` } }); issueId = issue.id;
        await db.operationalIssueTransition.create({ data: { issueId, operationalKey: issue.operationalKey, issueCode: issue.issueCode,
          fromWorkflowState: "ACTION_REQUIRED", toWorkflowState: "ACTION_REQUIRED", transitionCode: "STAY_TIME_OPERATOR_REVIEWED",
          transitionSummary: "Existing operator review", transitionedBy: "PIN_GO", sourceType: "MANUAL" } });
        now = (await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } })).stayTimeRecoveryNextAt!;
      }
      deps.retrieveUnpaidSession = async snapshot => {
        if (scenario === "provider-outage") throw new Error("synthetic provider unavailable");
        const evidence: import("./stay-time-payment-evidence.js").StayTimeUnpaidExpiryEvidence & ReturnType<typeof syntheticStayTimePaymentEvidence> =
          syntheticStayTimePaymentEvidence(snapshot, snapshot.reservation, now);
        Object.assign(evidence.session, { status: "expired", payment_status: "unpaid", payment_intent: null,
          after_expiration: null, recovered_from: null, invoice: null, subscription: null, setup_intent: null });
        if (scenario === "intent-present") evidence.session.payment_intent = "pi_pending";
        if (scenario.startsWith("canceled-")) {
          Object.assign(evidence.paymentIntent, { id: `pi_${m.id}`, status: "canceled", amount_received: 0, amount_capturable: 0,
            latest_charge: null, transfer_data: null, canceled_at: Math.floor(now.getTime() / 1000) - 60 });
          evidence.session.payment_intent = evidence.paymentIntent.id;
          evidence.canceledPaymentIntent = evidence.paymentIntent;
          if (scenario === "canceled-stored-intent") await db.reservationModification.update({ where: { id: m.id }, data: { stripePaymentIntentId: evidence.paymentIntent.id } });
          if (scenario === "canceled-processing") evidence.paymentIntent.status = "processing";
          if (scenario === "canceled-charge") evidence.paymentIntent.latest_charge = "ch_failed";
          if (scenario === "canceled-intent-race") await db.reservationModification.update({ where: { id: m.id }, data: { stripePaymentIntentId: "pi_changed" } });
          if (scenario === "canceled-lost-lease") await db.reservationModification.update({ where: { id: m.id }, data: { stayTimeRecoveryLeaseToken: "another-worker" } });
        }
        if (scenario === "stale-evidence") now = new Date(now.getTime() + 60_001);
        if (scenario === "lost-lease") await db.reservationModification.update({ where: { id: m.id }, data: { stayTimeRecoveryLeaseToken: "another-worker" } });
        if (scenario === "expired-lease") { now = new Date(now.getTime() + 11 * 60_000); evidence.retrievedAt = now; }
        if (scenario === "payment-race") await db.reservationModification.update({ where: { id: m.id }, data: { status: "PAYMENT_PROCESSING", stripePaymentIntentId: `pi_${m.id}`, stripePaymentStatus: "paid" } });
        if (scenario === "account-race") await db.reservation.update({ where: { id: r.id }, data: { stripeConnectedAccountId: "acct_changed" } });
        return evidence;
      };
      if (scenario === "journal-outage" || scenario === "canceled-journal-outage") {
        deps.client = new Proxy(db, { get(target, field) {
          if (field !== "$transaction") return Reflect.get(target, field);
          return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => work(new Proxy(tx, { get(inner, key) {
            if (key !== "operationalIssue") return Reflect.get(inner, key);
            return new Proxy(inner.operationalIssue, { get(delegate, method) {
              if (method === "upsert") return async (args: { create: { workflowState: string } }) => {
                if (args.create.workflowState === "RESOLVED") throw new Error("synthetic closure outage");
                return (delegate.upsert as Function)(args);
              };
              return Reflect.get(delegate, method);
            } });
          } })));
        } });
        await assert.rejects(runStayTimeRecoveryBatch(deps), /synthetic closure outage/);
        const saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
        assert.equal(saved.status, "AWAITING_PAYMENT"); assert.equal(saved.failureCode, null); assert.ok(saved.stayTimeRecoveryLeaseToken);
        assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { id: issueId! } })).workflowState, "ACTION_REQUIRED");
        deps.client = db; now = saved.stayTimeRecoveryLeaseUntil!;
      }
      const batches = await Promise.all(Array.from({ length: scenario === "concurrent" ? 2 : 1 }, () => runStayTimeRecoveryBatch(deps)));
      const saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
      const terminal = ["expired-unpaid", "already-expired", "no-incident", "concurrent", "journal-outage",
        "canceled-intent", "canceled-stored-intent", "canceled-journal-outage"].includes(scenario);
      if (terminal) {
        assert.equal(saved.status, "EXPIRED"); assert.equal(saved.failureCode, "STAY_TIME_EXPIRED_UNPAID");
        assert.equal(saved.stayTimeRecoveryNextAt, null); assert.equal(saved.stayTimeRecoveryLeaseToken, null); assert.equal(saved.stripePaymentStatus, null);
        assert.equal(batches.flatMap(b => b.results).filter(r => r.outcome === "EXPIRED_UNPAID").length, 1);
        const journal = saved.failureDetails as { version: string; paymentIntentAbsent: boolean; canceledPaymentIntentId?: string; paymentIntentStatus?: string; chargeAbsent?: boolean };
        assert.equal(journal.version, "stay_time_unpaid_expiry_v1"); assert.equal(journal.paymentIntentAbsent, !scenario.startsWith("canceled-"));
        if (scenario.startsWith("canceled-")) {
          assert.ok(journal.canceledPaymentIntentId); assert.equal(journal.paymentIntentStatus, "canceled"); assert.equal(journal.chargeAbsent, true);
        }
        now = new Date(now.getTime() + 2 * 3_600_000); assert.equal((await runStayTimeRecoveryBatch(deps)).processed, 0);
        if (issueId) {
          const issue = await db.operationalIssue.findUniqueOrThrow({ where: { id: issueId } });
          assert.equal(issue.workflowState, "RESOLVED"); assert.equal(issue.resolutionCode, "STAY_TIME_EXPIRED_UNPAID");
          assert.equal(await db.operationalIssueTransition.count({ where: { issueId } }), 3);
          assert.equal(await db.operationalIssueTransition.count({ where: { issueId, transitionSummary: "Existing operator review" } }), 1);
        } else assert.equal(await db.operationalIssue.count({ where: { reservationId: r.id } }), 0);
      } else {
        assert.notEqual(saved.failureCode, "STAY_TIME_EXPIRED_UNPAID");
        assert.equal(saved.status, scenario === "payment-race" ? "PAYMENT_PROCESSING" : "AWAITING_PAYMENT");
        assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { id: issueId! } })).workflowState, "ACTION_REQUIRED");
        if (scenario === "lost-lease" || scenario === "canceled-lost-lease") assert.equal(saved.stayTimeRecoveryLeaseToken, "another-worker");
      }
      if (scenario !== "account-race") assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: r.id } }), r);
      assert.equal(saved.stripeChargeId, null); assert.equal(saved.appliedAt, null); assert.equal(saved.stayTimeReconciledAt, null);
    } finally {
      await db.operationalIssue.deleteMany({ where: { reservationId: r.id } });
      await db.reservationModification.deleteMany({ where: { reservationId: r.id } }); await db.reservation.delete({ where: { id: r.id } });
      await db.property.delete({ where: { id: property.id } }); await db.organization.delete({ where: { id: org.id } });
    }
  });
});
