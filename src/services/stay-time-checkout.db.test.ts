import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings.js";
import { createStayTimeProposal, confirmStayTimeProposal, stageStayTimeModification } from "./stay-time-proposal.service.js";
import { syntheticStayTimePaymentEvidence } from "./stay-time-payment-evidence.fixture.js";
import { createStayTimeCheckout, handleStayTimeStripeWebhook, type StayTimeCheckoutDependencies, type StayTimeCheckoutStripeClient } from "./stay-time-checkout.service.js";
import { createStayTimeStripeProvider, type StayTimeStripeClient } from "./stay-time-stripe-provider.js";
import type { StayTimePaymentFlowDependencies } from "./stay-time-payment-flow.service.js";

// Compile against the installed SDK without creating any live session/client.
const acceptsInstalledSdk = (sdk: Stripe): StayTimeCheckoutStripeClient => sdk;
void acceptsInstalledSdk;
const signing = new Stripe("sk_test_synthetic_offline_only");
const secret = "whsec_synthetic_offline_only";
const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("internal Checkout creation and signed events preserve one incremental payment across retries", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  t.after(() => db.$disconnect());
  for (const scenario of ["late", "early", "concurrent-create", "lost-response", "webhook-repairs-lost-response", "webhook-before-create-returns",
    "replay-near-deadline", "wrong-guest", "wrong-payout-account", "price-changed-before", "price-changed-during-create",
    "blocked-during-create", "cleaning-revoked-during-create", "expired-during-create", "expiry-loses-to-payment",
    "expired-session", "delayed-payment", "unpaid-event", "bad-signature", "tampered-body", "wrong-event-account",
    "wrong-retrieved-session", "wrong-created-amount", "wrong-mode", "unrelated-event", "provider-outage"] as const) {
    await t.test(scenario, async () => {
      const early = scenario === "early" || scenario === "cleaning-revoked-during-create";
      const stagedAt = new Date(early ? "2026-10-01T12:00Z" : "2026-10-02T12:00Z");
      let now = new Date(stagedAt.getTime() + 120_000);
      const org = await db.organization.create({ data: { name: "Synthetic Checkout" } });
      const defaults = defaultStayTimeSettings();
      const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic Checkout",
        timezone: "America/Puerto_Rico", checkInTime: early ? "15:00" : "16:00", checkOutTime: "11:00", cleaningNfcEnabled: true,
        cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180,
        stayTimeSettings: { earlyCheckin: { ...defaults.earlyCheckin, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 0, currency: "USD" } },
          lateCheckout: { ...defaults.lateCheckout, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 0, currency: "USD" } } } } });
      const reservation = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest", guestEmail: "synthetic@example.invalid",
        guestToken: `synthetic-checkout-${property.id}`, checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T15:00Z"),
        status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT",
        stripeConnectedAccountId: "acct_synthetic_checkout", stripePaymentIntentId: `pi_original_${property.id}`,
        currency: "usd", totalAmount: 150, amountCollected: 150, platformFeeAmount: 2.25, hostPayoutAmount: 147.75,
        pricingBreakdown: { currency: "usd", totalAmount: 150, totalAmountCents: 15000,
          nightlySubtotal: 100, nightlyRates: [{ date: "2026-10-01", rate: 40 }, { date: "2026-10-02", rate: 60 }],
          cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0 } } });
      let staffId: string | undefined, workId: string | undefined;
      try {
        if (early) {
          const prior = await db.reservation.create({ data: { propertyId: property.id, guestName: "Prior synthetic guest",
            checkIn: new Date("2026-09-29T19:00Z"), checkOut: new Date("2026-10-01T10:00Z") } });
          const staff = await db.staffMember.create({ data: { organizationId: org.id, fullName: "Synthetic cleaner" } });
          staffId = staff.id;
          await db.propertyStaff.create({ data: { propertyId: property.id, staffMemberId: staff.id, role: "PRIMARY" } });
          const confirmation = await db.cleaningConfirmation.create({ data: { reservationId: prior.id, propertyId: property.id,
            staffMemberId: staff.id, status: "CONFIRMED", token: `synthetic-checkout-${staff.id}` } });
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
        const m = staged.modification, account = reservation.stripeConnectedAccountId!;
        const objects = syntheticStayTimePaymentEvidence({ ...m, stripeConnectedAccountId: account,
          stripeCheckoutSessionId: `cs_${m.id}`, stripePaymentIntentId: `pi_${m.id}`, stripeChargeId: `ch_${m.id}`,
          stripeApplicationFeeId: `fee_${m.id}` }, reservation, now);
        let session: Stripe.Checkout.Session = { ...objects.session, status: "open", payment_status: "unpaid", payment_intent: null,
          url: `https://checkout.stripe.com/c/pay/cs_${m.id}` };
        let creates = 0, retrieves = 0, expires = 0, payoutCalls = 0, reconciles = 0, refundCreates = 0;
        let firstParams: Stripe.Checkout.SessionCreateParams | undefined;
        const refunds: Stripe.Refund[] = [];
        const paid = () => { session = { ...objects.session, url: null }; };
        const scoped = (opts?: Stripe.RequestOptions) => assert.equal(opts?.stripeAccount, account);
        const sdk: StayTimeCheckoutStripeClient & StayTimeStripeClient = {
          webhooks: signing.webhooks,
          checkout: { sessions: {
            create: async (params, opts) => {
              creates++; scoped(opts);
              assert.equal(opts.idempotencyKey, `direct-booking-reservation-modification-checkout:${m.id}`);
              if (firstParams) assert.deepEqual(params, firstParams); else firstParams = structuredClone(params);
              assert.equal(params.payment_method_types, undefined);
              assert.equal(params.expires_at, Math.floor(m.checkoutExpiresAt!.getTime() / 1000));
              assert.equal(params.payment_intent_data?.application_fee_amount, objects.paymentIntent.application_fee_amount);
              assert.equal(params.line_items?.[0]?.price_data?.unit_amount, objects.session.amount_total);
              if (scenario === "provider-outage" && creates === 1) throw new Error("Synthetic provider outage");
              if (["lost-response", "webhook-repairs-lost-response"].includes(scenario) && creates === 1) throw new Error("Synthetic response lost after creation");
              if (scenario === "price-changed-during-create") await db.reservation.update({ where: { id: reservation.id }, data: { totalAmount: 151 } });
              if (["blocked-during-create", "expiry-loses-to-payment"].includes(scenario)) await db.propertyBlockedDate.create({ data: {
                propertyId: property.id, startDate: new Date("2026-10-03T19:59Z"), endDate: new Date("2026-10-04T15:00Z") } });
              if (scenario === "cleaning-revoked-during-create") await db.cleaningWork.update({ where: { id: workId! }, data: { completionConfirmedAt: null } });
              if (scenario === "expired-during-create") now = m.checkoutExpiresAt!;
              if (scenario === "webhook-before-create-returns") { paid(); assert.equal((await webhook()).outcome, "APPLIED"); }
              if (scenario === "wrong-created-amount") return { ...session, amount_total: 999999 };
              if (scenario === "wrong-mode") return { ...session, livemode: true };
              return structuredClone(session);
            },
            retrieve: async (id, _params, opts) => {
              retrieves++; scoped(opts); assert.equal(id, session.id);
              return scenario === "wrong-retrieved-session" ? { ...session, id: "cs_other" } : structuredClone(session);
            },
            expire: async (id, _params, opts) => {
              expires++; scoped(opts); assert.equal(id, session.id);
              if (scenario === "expiry-loses-to-payment") { paid(); throw new Error("Session completed before expire"); }
              session = { ...session, status: "expired", url: null };
              return structuredClone(session);
            },
          } },
          paymentIntents: { retrieve: async (_id, _params, opts) => { scoped(opts); return objects.paymentIntent; } },
          charges: { retrieve: async (_id, _params, opts) => { scoped(opts); return objects.charge; } },
          applicationFees: { retrieve: async () => objects.applicationFee! },
          refunds: {
            list: async (_params, opts) => { scoped(opts); return { object: "list", data: refunds, has_more: false, url: "/v1/refunds" }; },
            retrieve: async (id, _params, opts) => { scoped(opts); return refunds.find(r => r.id === id)!; },
            create: async (params, opts) => {
              scoped(opts); refundCreates++;
              assert.equal(params.charge, objects.charge.id); assert.notEqual(params.payment_intent, reservation.stripePaymentIntentId);
              const receipt = { id: `re_${m.id}`, object: "refund", amount: params.amount!, charge: objects.charge.id,
                payment_intent: objects.paymentIntent.id, currency: "usd", status: "succeeded", metadata: params.metadata,
                created: Math.floor(now.getTime() / 1000) } as Stripe.Refund;
              refunds.push(receipt);
              objects.charge.refunded = true; objects.charge.amount_refunded = objects.charge.amount;
              objects.applicationFee!.refunded = true; objects.applicationFee!.amount_refunded = objects.applicationFee!.amount;
              return receipt;
            },
          },
        };
        const deps: StayTimeCheckoutDependencies = { client: db, now: () => now, stripe: sdk, livemode: false,
          appUrl: "https://pingo.example.invalid", assertPayoutReady: async organizationId => {
            payoutCalls++; assert.equal(organizationId, org.id);
            return { connectedAccountId: scenario === "wrong-payout-account" ? "acct_wrong" : account };
          } };
        const payment: StayTimePaymentFlowDependencies = { client: db, now: () => now,
          ...createStayTimeStripeProvider(sdk, () => now), reconcile: async () => { reconciles++; } };
        const webhook = async () => {
          const body = JSON.stringify({ id: "evt_synthetic", object: "event", type: scenario === "unrelated-event" ? "customer.created" : "checkout.session.completed",
            livemode: false, account: scenario === "wrong-event-account" ? "acct_wrong" : account,
            data: { object: session } });
          const signature = signing.webhooks.generateTestHeaderString({ payload: body, secret });
          return handleStayTimeStripeWebhook({ rawBody: Buffer.from(body + (scenario === "tampered-body" ? " " : "")),
            signature: scenario === "bad-signature" ? "invalid" : signature }, { ...deps, payment, webhookSecret: secret });
        };
        const run = () => createStayTimeCheckout({ modificationId: m.id, guestToken: scenario === "wrong-guest" ? "wrong" : reservation.guestToken! }, deps);
        if (scenario === "price-changed-before") await db.reservation.update({ where: { id: reservation.id }, data: { totalAmount: 151 } });
        if (["wrong-guest", "wrong-payout-account", "price-changed-before"].includes(scenario)) {
          await assert.rejects(run); assert.equal(creates, 0); assert.equal(retrieves, 0);
          if (scenario === "wrong-guest") assert.equal(payoutCalls, 0);
          return;
        }
        if (["wrong-created-amount", "wrong-mode"].includes(scenario)) {
          await assert.rejects(run, (e: unknown) => (e as { code: string }).code === "STAY_TIME_CHECKOUT_SESSION_MISMATCH");
          assert.equal((await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } })).stripeCheckoutSessionId, null);
          assert.equal(reconciles, 0); return;
        }
        if (["price-changed-during-create", "blocked-during-create", "cleaning-revoked-during-create", "expired-during-create", "expiry-loses-to-payment"].includes(scenario)) {
          await assert.rejects(run); assert.equal(expires, 1); assert.equal(reconciles, 0);
          const saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
          assert.equal(saved.stripeCheckoutSessionId, session.id); assert.equal(saved.appliedAt, null);
          if (scenario === "expiry-loses-to-payment") {
            assert.equal((await webhook()).outcome, "REFUNDED"); assert.equal(refundCreates, 1);
          } else assert.equal(saved.status, "EXPIRED");
          return;
        }
        if (["lost-response", "webhook-repairs-lost-response", "provider-outage"].includes(scenario)) {
          await assert.rejects(run);
          const saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
          assert.equal(saved.stripeCheckoutSessionId, null); assert.equal(saved.failureCode, "STAY_TIME_CHECKOUT_PREPARED");
          if (scenario === "webhook-repairs-lost-response") {
            paid(); assert.equal((await webhook()).outcome, "APPLIED"); assert.equal(creates, 1); return;
          }
          // Deployment URL changes must not alter a provider idempotency retry.
          // Property edits intentionally invalidate the confirmed policy version.
          deps.appUrl = "https://new-pingo.example.invalid";
        }
        if (scenario === "concurrent-create") {
          const results = await Promise.all([run(), run()]);
          assert.equal(results[0].checkoutUrl, results[1].checkoutUrl);
          assert.ok(results.every(r => r.outcome === "CHECKOUT_READY"));
        } else {
          const result = await run();
          assert.equal(result.outcome, scenario === "webhook-before-create-returns" ? "PAYMENT_PENDING" : "CHECKOUT_READY");
        }
        const saved = await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } });
        assert.equal(saved.stripeCheckoutSessionId, session.id); assert.deepEqual(saved.checkoutExpiresAt, m.checkoutExpiresAt);
        if (scenario === "webhook-before-create-returns") { assert.equal(saved.status, "APPLIED"); return; }
        assert.equal(saved.status, "AWAITING_PAYMENT");
        assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } }), reservation);
        if (scenario === "replay-near-deadline") {
          now = new Date(m.checkoutExpiresAt!.getTime() - 60_000);
          const count = creates; assert.equal((await run()).outcome, "CHECKOUT_READY"); assert.equal(creates, count);
        }
        if (scenario === "expired-session") {
          session = { ...session, status: "expired" };
          await assert.rejects(run); assert.equal(creates, 1);
          assert.equal((await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } })).status, "EXPIRED"); return;
        }
        paid();
        if (scenario === "unpaid-event") session.payment_status = "unpaid";
        if (scenario === "delayed-payment") now = new Date(m.checkoutExpiresAt!.getTime() + 1000);
        const beforeRetrieval = retrieves;
        if (["bad-signature", "tampered-body", "wrong-event-account", "wrong-retrieved-session"].includes(scenario)) {
          await assert.rejects(webhook); assert.equal(reconciles, 0); assert.equal(refundCreates, 0);
          if (scenario !== "wrong-retrieved-session") assert.equal(retrieves, beforeRetrieval);
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } }), reservation); return;
        }
        const outcome = scenario === "unpaid-event" ? "PAYMENT_PENDING" : scenario === "unrelated-event" ? "IGNORED" : scenario === "delayed-payment" ? "REFUNDED" : "APPLIED";
        assert.equal((await webhook()).outcome, outcome);
        const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        if (outcome === "APPLIED") {
          assert.equal(Number(after.amountCollected), 150 + Number(m.additionalChargeAmount));
          assert.equal(after.checkIn.toISOString(), early ? "2026-10-01T16:00:00.000Z" : reservation.checkIn.toISOString());
          assert.equal(after.checkOut.toISOString(), early ? reservation.checkOut.toISOString() : "2026-10-03T16:30:00.000Z");
          assert.ok(reconciles > 0);
        } else assert.deepEqual(after, reservation);
        assert.equal((await webhook()).outcome, outcome);
        assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } }), after);
        assert.equal(refundCreates, outcome === "REFUNDED" ? 1 : 0);
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
