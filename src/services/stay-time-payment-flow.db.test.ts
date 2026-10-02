import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { Prisma, PrismaClient } from "@prisma/client";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings.js";
import { createStayTimeProposal, confirmStayTimeProposal, stageStayTimeModification } from "./stay-time-proposal.service.js";
import { syntheticStayTimePaymentEvidence } from "./stay-time-payment-evidence.fixture.js";
import { processStayTimePayment, type StayTimePaymentFlowDependencies, type StayTimeRefundEvidence } from "./stay-time-payment-flow.service.js";
import { GuestReservationModificationError } from "./guest-reservation-modification.service.js";
import { createStayTimeStripeProvider, type StayTimeStripeClient } from "./stay-time-stripe-provider.js";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("paid stay-time processing applies once or durably recovers only the incremental payment", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  t.after(() => db.$disconnect());
  for (const scenario of ["late", "early", "stripe-adapter-apply", "stripe-adapter-refund", "concurrent-apply", "serialization-burst", "serialization-exhausted", "revoked-cleaning", "blocked-turnover", "price-changed", "expired", "expired-status",
    "refund-outage", "refund-response-lost", "refund-pending", "refund-wrong-receipt", "concurrent-refund",
    "payment-outage", "wrong-payment", "partially-refunded", "wrong-account", "reconcile-outage", "cancelled-without-recovery"] as const) {
    await t.test(scenario, async () => {
      const early = scenario === "early" || scenario === "revoked-cleaning";
      const stagedAt = new Date(early ? "2026-10-01T12:00Z" : "2026-10-02T12:00Z");
      let now = new Date(stagedAt.getTime() + (scenario === "expired" ? 3_600_000 : 120_000));
      const org = await db.organization.create({ data: { name: "Synthetic paid flow" } });
      const defaults = defaultStayTimeSettings();
      const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic paid flow",
        timezone: "America/Puerto_Rico", checkInTime: early ? "15:00" : "16:00", checkOutTime: "11:00", cleaningNfcEnabled: true,
        cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180,
        stayTimeSettings: { earlyCheckin: { ...defaults.earlyCheckin, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 0, currency: "USD" } },
          lateCheckout: { ...defaults.lateCheckout, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 0, currency: "USD" } } } } });
      const reservation = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest",
        guestToken: `synthetic-payment-flow-${property.id}`, checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T15:00Z"),
        status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT",
        stripeConnectedAccountId: "acct_synthetic_flow", stripePaymentIntentId: `pi_original_${property.id}`,
        currency: "usd", totalAmount: 150, amountCollected: 150, platformFeeAmount: 2.25, hostPayoutAmount: 147.75,
        pricingBreakdown: { currency: "usd", totalAmount: 150, totalAmountCents: 15000,
          nightlySubtotal: 100, nightlyRates: [{ date: "2026-10-01", rate: 40 }, { date: "2026-10-02", rate: 60 }],
          cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0 } } });
      let staffId: string | undefined;
      let workId: string | undefined;
      try {
        if (early) {
          const prior = await db.reservation.create({ data: { propertyId: property.id, guestName: "Prior synthetic guest",
            checkIn: new Date("2026-09-29T19:00Z"), checkOut: new Date("2026-10-01T10:00Z") } });
          const staff = await db.staffMember.create({ data: { organizationId: org.id, fullName: "Synthetic cleaner" } });
          staffId = staff.id;
          await db.propertyStaff.create({ data: { propertyId: property.id, staffMemberId: staff.id, role: "PRIMARY" } });
          const confirmation = await db.cleaningConfirmation.create({ data: { reservationId: prior.id, propertyId: property.id,
            staffMemberId: staff.id, status: "CONFIRMED", token: `synthetic-flow-${staff.id}` } });
          const work = await db.cleaningWork.create({ data: { reservationId: prior.id, propertyId: property.id, staffMemberId: staff.id,
            confirmationId: confirmation.id, scheduledStartAt: new Date("2026-10-01T10:30Z"), durationCommitmentMinutes: 30,
            startConfirmationGraceMinutes: 5, followupGraceMinutes: 5, timingConsentVersion: "v1",
            timingConsentAcceptedAt: new Date("2026-09-29T15:00Z"), startConfirmedAt: new Date("2026-10-01T10:30Z"),
            completionConfirmedAt: new Date("2026-10-01T11:00Z") } });
          workId = work.id;
        }
        const options = { now: stagedAt, platformFeePercent: "1.5" };
        const proposal = await createStayTimeProposal(db, { guestToken: reservation.guestToken!, language: "es",
          operation: early ? "EARLY_CHECKIN" : "LATE_CHECKOUT", requestedLocalTime: early ? "12:00" : "12:30" }, options);
        await confirmStayTimeProposal(db, { guestToken: reservation.guestToken!, proposalId: proposal.proposal.id,
          confirmationToken: proposal.confirmationToken }, options);
        const staged = await stageStayTimeModification(db, { guestToken: reservation.guestToken!, proposalId: proposal.proposal.id }, options);
        const id = staged.modification.id;
        // Simulate the persisted result of Checkout creation. No Stripe session is created.
        await db.reservationModification.update({ where: { id }, data: { stripeConnectedAccountId: reservation.stripeConnectedAccountId,
          stripeCheckoutSessionId: `cs_${id}`, ...(scenario === "cancelled-without-recovery" ? { status: "CANCELLED" } : {}),
          ...(scenario === "expired-status" ? { status: "EXPIRED", expiredAt: now } : {}) } });
        const needsRefund = ["stripe-adapter-refund", "revoked-cleaning", "blocked-turnover", "price-changed", "expired", "expired-status", "refund-outage", "refund-response-lost",
          "refund-pending", "refund-wrong-receipt", "concurrent-refund"].includes(scenario);
        if (scenario === "revoked-cleaning") await db.cleaningWork.update({ where: { id: workId! }, data: { completionConfirmedAt: null } });
        if (needsRefund && !["revoked-cleaning", "price-changed", "expired", "expired-status"].includes(scenario)) await db.propertyBlockedDate.create({
          data: { propertyId: property.id, startDate: new Date("2026-10-03T19:59Z"), endDate: new Date("2026-10-04T15:00Z") } });
        if (scenario === "price-changed") await db.reservation.update({ where: { id: reservation.id }, data: { totalAmount: 151 } });
        const before = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        const refundLedger = new Map<string, StayTimeRefundEvidence>();
        let retrieveCalls = 0, refundCalls = 0, reconcileCalls = 0;
        const deps: StayTimePaymentFlowDependencies = {
          client: db, now: () => now,
          retrievePayment: async m => {
            retrieveCalls++;
            if (scenario === "payment-outage" && retrieveCalls === 1) throw new Error("Synthetic payment outage");
            const evidence = syntheticStayTimePaymentEvidence({ ...m, stripePaymentIntentId: `pi_${id}`, stripeChargeId: `ch_${id}`,
              stripeApplicationFeeId: `fee_${id}` }, m.reservation, now);
            if (scenario === "wrong-payment") evidence.session.id = "cs_wrong";
            if (scenario === "partially-refunded") evidence.charge.amount_refunded = 1;
            return evidence;
          },
          reconcile: async () => {
            reconcileCalls++;
            if (scenario === "reconcile-outage" && reconcileCalls === 1) throw new GuestReservationModificationError({
              code: "SYNTHETIC_RECONCILE_ERROR", message: "Synthetic post-commit reconcile outage", statusCode: 409 });
          },
          ensureRefund: async request => {
            refundCalls++;
            assert.equal(request.amountMinor, Math.round(Number(staged.modification.additionalChargeAmount) * 100));
            assert.equal(request.chargeId, `ch_${id}`);
            assert.notEqual(request.paymentIntentId, reservation.stripePaymentIntentId);
            assert.equal(request.idempotencyKey, `stay-time-recovery:${id}`);
            if (scenario === "refund-outage" && refundCalls === 1) throw new Error("Synthetic refund outage");
            let result = refundLedger.get(request.idempotencyKey);
            if (!result) {
              result = { refundId: `re_${id}`, connectedAccountId: request.connectedAccountId, chargeId: request.chargeId,
                paymentIntentId: request.paymentIntentId, amountMinor: request.amountMinor, currency: "usd",
                platformFeeRefundedMinor: request.platformFeeMinor, status: scenario === "refund-pending" ? "pending" : "succeeded" };
              refundLedger.set(request.idempotencyKey, result);
            }
            if (scenario === "refund-response-lost" && refundCalls === 1) throw new Error("Synthetic response lost after refund");
            if (scenario === "refund-wrong-receipt" && refundCalls === 1) return { ...result, amountMinor: result.amountMinor + 1 };
            if (scenario === "refund-pending" && refundCalls > 1) {
              assert.equal(request.existingRefundId, result.refundId);
              result = { ...result, status: "succeeded" };
              refundLedger.set(request.idempotencyKey, result);
            }
            return result;
          },
        };
        if (scenario.startsWith("stripe-adapter-")) {
          const objects = syntheticStayTimePaymentEvidence({ ...staged.modification,
            stripeConnectedAccountId: reservation.stripeConnectedAccountId, stripeCheckoutSessionId: `cs_${id}`,
            stripePaymentIntentId: `pi_${id}`, stripeChargeId: `ch_${id}`, stripeApplicationFeeId: `fee_${id}` }, reservation, now);
          let receipt: Stripe.Refund | undefined;
          const scoped = (options: Stripe.RequestOptions) => assert.equal(options.stripeAccount, reservation.stripeConnectedAccountId);
          const client: StayTimeStripeClient = {
            checkout: { sessions: { retrieve: async (_id, _params, options) => { scoped(options); retrieveCalls++; return objects.session; } } },
            paymentIntents: { retrieve: async (_id, _params, options) => { scoped(options); return objects.paymentIntent; } },
            charges: { retrieve: async (_id, _params, options) => { scoped(options); return objects.charge; } },
            applicationFees: { retrieve: async () => objects.applicationFee! },
            refunds: {
              list: async (_params, options) => { scoped(options); return { object: "list", data: receipt ? [receipt] : [], has_more: false, url: "/v1/refunds" }; },
              retrieve: async (refundId, _params, options) => { scoped(options); assert.equal(refundId, receipt?.id); return receipt!; },
              create: async (params, options) => {
                scoped(options); refundCalls++;
                assert.equal(params.charge, `ch_${id}`); assert.equal(params.amount, objects.charge.amount);
                assert.equal(params.refund_application_fee, true); assert.equal(options.idempotencyKey, `stay-time-recovery:${id}`);
                receipt = { id: `re_${id}`, object: "refund", charge: `ch_${id}`, payment_intent: `pi_${id}`,
                  amount: objects.charge.amount, currency: "usd", status: "succeeded", metadata: params.metadata,
                  transfer_reversal: null, source_transfer_reversal: null } as Stripe.Refund;
                objects.charge.amount_refunded = objects.charge.amount; objects.charge.refunded = true;
                objects.applicationFee!.amount_refunded = objects.applicationFee!.amount; objects.applicationFee!.refunded = true;
                refundLedger.set(options.idempotencyKey!, { refundId: receipt.id, chargeId: `ch_${id}`, paymentIntentId: `pi_${id}`,
                  connectedAccountId: reservation.stripeConnectedAccountId!, amountMinor: receipt.amount, currency: "usd",
                  status: "succeeded", platformFeeRefundedMinor: objects.applicationFee!.amount });
                return receipt;
              },
            },
          };
          Object.assign(deps, createStayTimeStripeProvider(client, () => now));
        }
        const scope = { modificationId: id, checkoutSessionId: `cs_${id}`,
          connectedAccountId: scenario === "wrong-account" ? "acct_wrong" : reservation.stripeConnectedAccountId! };
        let injectedConflicts = 0;
        if (scenario.startsWith("serialization-")) {
          const limit = scenario === "serialization-burst" ? 4 : 10;
          deps.client = new Proxy(db, { get(target, key) {
            if (key !== "$transaction") return Reflect.get(target, key);
            return (async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => db.$transaction(async tx => {
              if (injectedConflicts < limit) {
                injectedConflicts++;
                throw new Prisma.PrismaClientKnownRequestError("Synthetic first-lock serialization conflict", {
                  code: "P2010", clientVersion: Prisma.prismaVersion.client, meta: { code: "40001" },
                });
              }
              return work(tx);
            }, options)) as typeof db.$transaction;
          } });
        }
        const run = () => processStayTimePayment(scope, deps);
        if (scenario === "serialization-exhausted") {
          await assert.rejects(run, /Synthetic first-lock serialization conflict/);
          assert.equal(injectedConflicts, 5); assert.equal(retrieveCalls, 0); assert.equal(refundCalls, 0); assert.equal(reconcileCalls, 0);
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } }), before);
          assert.equal((await db.reservationModification.findUniqueOrThrow({ where: { id } })).status, "AWAITING_PAYMENT");
          return;
        }
        const rejected = ["wrong-payment", "partially-refunded", "wrong-account", "cancelled-without-recovery"].includes(scenario);
        if (rejected) {
          await assert.rejects(run, (error: unknown) => ["STAY_TIME_PAYMENT_EVIDENCE_MISMATCH", "STAY_TIME_PAYMENT_SCOPE_MISMATCH", "STAY_TIME_RECOVERY_CONFLICT"].includes((error as { code: string }).code));
          assert.equal(refundCalls, 0); assert.equal(reconcileCalls, 0);
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } }), before);
          return;
        }
        if (["payment-outage", "refund-outage", "refund-response-lost", "refund-wrong-receipt", "reconcile-outage"].includes(scenario)) {
          await assert.rejects(run);
          const pending = await db.reservationModification.findUniqueOrThrow({ where: { id } });
          assert.equal(pending.status, scenario === "payment-outage" ? "PAYMENT_PROCESSING" : scenario === "reconcile-outage" ? "APPLIED" : "CANCELLED");
          if (needsRefund) assert.equal(pending.failureCode, "STAY_TIME_REFUND_PENDING");
        }
        if (scenario === "refund-pending") {
          assert.equal((await run()).outcome, "REFUND_PENDING");
          // Retry after the quote/payment deadline: recovery remains possible.
          now = new Date(now.getTime() + 86_400_000);
        }
        const results = scenario.startsWith("concurrent-") ? await Promise.all([run(), run()]) : [await run()];
        for (const result of results) assert.equal(result.outcome, needsRefund ? "REFUNDED" : "APPLIED");
        if (scenario === "serialization-burst") { assert.equal(injectedConflicts, 4); assert.equal(retrieveCalls, 1); }
        const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        const final = await db.reservationModification.findUniqueOrThrow({ where: { id } });
        if (needsRefund) {
          assert.deepEqual(after, before);
          assert.equal(final.status, "CANCELLED"); assert.equal(final.failureCode, "STAY_TIME_REFUNDED");
          assert.equal(final.appliedAt, null); assert.equal(reconcileCalls, 0); assert.equal(refundLedger.size, 1);
          const calls = refundCalls;
          assert.equal((await run()).outcome, "REFUNDED"); assert.equal(refundCalls, calls);
        } else {
          assert.equal(final.status, "APPLIED"); assert.equal(refundCalls, 0);
          assert.equal(after.checkIn.toISOString(), early ? "2026-10-01T16:00:00.000Z" : before.checkIn.toISOString());
          assert.equal(after.checkOut.toISOString(), early ? before.checkOut.toISOString() : "2026-10-03T16:30:00.000Z");
          assert.equal(Number(after.totalAmount), 150 + Number(staged.modification.additionalChargeAmount));
          assert.equal(Number(after.amountCollected), 150 + Number(staged.modification.additionalChargeAmount));
          assert.equal(Number(after.platformFeeAmount), 2.25 + Number(staged.modification.additionalPlatformFeeAmount));
          assert.equal(Number(after.hostPayoutAmount), 147.75 + Number(staged.modification.additionalHostPayoutAmount));
          assert.equal((await run()).outcome, "APPLIED");
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } }), after);
          assert.ok(reconcileCalls >= 2);
        }
      } finally {
        await db.reservationModification.deleteMany({ where: { reservationId: reservation.id } });
        await db.pinAIActionProposal.deleteMany({ where: { reservationId: reservation.id } });
        await db.cleaningWork.deleteMany({ where: { propertyId: property.id } });
        await db.cleaningConfirmation.deleteMany({ where: { propertyId: property.id } });
        await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
        await db.reservation.deleteMany({ where: { propertyId: property.id } });
        await db.propertyStaff.deleteMany({ where: { propertyId: property.id } });
        if (staffId) await db.staffMember.delete({ where: { id: staffId } });
        await db.property.delete({ where: { id: property.id } });
        await db.organization.delete({ where: { id: org.id } });
      }
    });
  }
});
