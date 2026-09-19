import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  extractDirectBookingStripeFinancialEvidence,
  reconcileDirectBookingDirectChargeFinancialEvidence,
} from "./direct-booking-stripe-financial-evidence.service.js";

const dashboardPayoutsRouteSource = fs.readFileSync(
  new URL("../routes/dashboard-payouts.routes.ts", import.meta.url),
  "utf8"
);

test("extracts direct charge Stripe fee and actual host net from expanded balance transaction", () => {
  const paymentIntent = {
    id: "pi_direct",
    application_fee_amount: 123,
    latest_charge: {
      id: "ch_direct",
      object: "charge",
      transfer: null,
      application_fee: { id: "fee_direct" },
      balance_transaction: {
        id: "txn_direct",
        object: "balance_transaction",
        fee: 182,
        net: 818,
        currency: "usd",
      },
    },
  } as any;

  assert.deepEqual(
    extractDirectBookingStripeFinancialEvidence(paymentIntent),
    {
      stripeChargeId: "ch_direct",
      stripeTransferId: null,
      stripeApplicationFeeId: "fee_direct",
      stripeBalanceTransactionId: "txn_direct",
      stripeProcessingFeeAmountCents: 59,
      applicationFeeAmountCents: 123,
      hostNetAmountCents: 818,
      balanceCurrency: "usd",
    }
  );
});

test("does not invent actual fee or host net when balance transaction is not expanded", () => {
  const paymentIntent = {
    id: "pi_pending",
    application_fee_amount: 123,
    latest_charge: {
      id: "ch_pending",
      object: "charge",
      application_fee: "fee_pending",
      balance_transaction: "txn_pending",
    },
  } as any;

  assert.deepEqual(
    extractDirectBookingStripeFinancialEvidence(paymentIntent),
    {
      stripeChargeId: "ch_pending",
      stripeTransferId: null,
      stripeApplicationFeeId: "fee_pending",
      stripeBalanceTransactionId: "txn_pending",
      stripeProcessingFeeAmountCents: null,
      applicationFeeAmountCents: 123,
      hostNetAmountCents: null,
      balanceCurrency: null,
    }
  );
});

test("Direct Charge financial evidence never records a destination transfer", () => {
  const paymentIntent = {
    id: "pi_direct",
    application_fee_amount: 100,
    latest_charge: {
      id: "ch_direct",
      object: "charge",
      transfer: { id: "tr_legacy_shape" },
      application_fee: "fee_direct",
      balance_transaction: null,
    },
  } as any;

  const evidence = extractDirectBookingStripeFinancialEvidence(paymentIntent);
  assert.equal(evidence.stripeTransferId, null);
  assert.equal(evidence.stripeChargeId, "ch_direct");
  assert.equal(evidence.stripeApplicationFeeId, "fee_direct");
  assert.equal(evidence.stripeProcessingFeeAmountCents, null);
  assert.equal(evidence.hostNetAmountCents, null);
});

test("latest charge id alone is preserved without fabricating fee data", () => {
  const paymentIntent = {
    id: "pi_unexpanded",
    application_fee_amount: 0,
    latest_charge: "ch_unexpanded",
  } as any;

  const evidence = extractDirectBookingStripeFinancialEvidence(paymentIntent);
  assert.equal(evidence.stripeChargeId, "ch_unexpanded");
  assert.equal(evidence.stripeBalanceTransactionId, null);
  assert.equal(evidence.stripeProcessingFeeAmountCents, null);
  assert.equal(evidence.hostNetAmountCents, null);
});

test("financial reconciliation is a strict no-op for legacy Direct Booking sessions", async () => {
  let reservationRead = false;
  let reservationWrite = false;
  let stripeRead = false;

  const result = await reconcileDirectBookingDirectChargeFinancialEvidence({
    reservationRepository: {
      async findUnique() {
        reservationRead = true;
        return null;
      },
      async update() {
        reservationWrite = true;
        return null;
      },
    },
    stripeClient: {
      paymentIntents: {
        async retrieve() {
          stripeRead = true;
          return {} as any;
        },
      },
    },
    event: {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_legacy",
          metadata: {
            flow: "direct_booking",
          },
        },
      },
    } as any,
  });

  assert.deepEqual(result, {
    handled: false,
    reason: "NOT_DIRECT_CHARGE",
  });
  assert.equal(reservationRead, false);
  assert.equal(reservationWrite, false);
  assert.equal(stripeRead, false);
});

test("financial reconciliation stores actual Stripe fee and host net for Direct Charges", async () => {
  const updates: any[] = [];
  const stripeCalls: any[] = [];

  const result = await reconcileDirectBookingDirectChargeFinancialEvidence({
    reservationRepository: {
      async findUnique() {
        return {
          id: "res_direct",
          stripePaymentIntentId: "pi_direct",
          stripeConnectedAccountId: "acct_host",
          stripeChargeId: null,
          stripeTransferId: null,
          stripeApplicationFeeId: null,
          hostPayoutAmount: 9,
          externalRaw: {
            existing: true,
          },
        };
      },
      async update(args: any) {
        updates.push(args);
        return args;
      },
    },
    stripeClient: {
      paymentIntents: {
        async retrieve(...args: any[]) {
          stripeCalls.push(args);

          assert.deepEqual(args[2], {
            stripeAccount: "acct_host",
          });

          return {
            id: "pi_direct",
            application_fee_amount: 123,
            latest_charge: {
              id: "ch_direct",
              object: "charge",
              transfer: null,
              application_fee: { id: "fee_direct" },
              balance_transaction: {
                id: "txn_direct",
                object: "balance_transaction",
                fee: 182,
                net: 818,
                currency: "usd",
              },
            },
          } as any;
        },
      },
    },
    event: {
      id: "evt_direct",
      type: "checkout.session.completed",
      account: "acct_host",
      data: {
        object: {
          id: "cs_direct",
          payment_intent: "pi_direct",
          metadata: {
            flow: "direct_booking",
            stripeChargeMode: "DIRECT_CHARGE",
            stripeConnectedAccountId: "acct_host",
          },
        },
      },
    } as any,
    now: new Date("2026-09-16T20:00:00.000Z"),
  });

  assert.equal(stripeCalls.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "res_direct");
  assert.equal(updates[0].data.hostPayoutAmount, 8.18);
  assert.equal(updates[0].data.stripeChargeId, "ch_direct");
  assert.equal(updates[0].data.stripeApplicationFeeId, "fee_direct");
  assert.equal(
    updates[0].data.externalRaw.stripeFinancialEvidence.stripeProcessingFeeAmount,
    0.59
  );
  assert.equal(
    updates[0].data.externalRaw.stripeFinancialEvidence.applicationFeeAmount,
    1.23
  );
  assert.equal(
    updates[0].data.externalRaw.stripeFinancialEvidence.hostNetAmount,
    8.18
  );
  assert.equal(
    updates[0].data.externalRaw.stripeFinancialEvidence.stripeBalanceTransactionId,
    "txn_direct"
  );
  assert.equal(updates[0].data.externalRaw.existing, true);

  assert.deepEqual(result, {
    handled: true,
    reservationId: "res_direct",
    paymentIntentId: "pi_direct",
    connectedAccountId: "acct_host",
    chargeMode: "DIRECT_CHARGE",
    stripeProcessingFeeAmountCents: 59,
    hostNetAmountCents: 818,
    stripeBalanceTransactionId: "txn_direct",
  });
});

test("host payout transactions stay scoped to the authenticated organization", () => {
  assert.match(
    dashboardPayoutsRouteSource,
    /const organizationId = getOrgIdFromRequest\(req\);[\s\S]*?property:\s*\{\s*organizationId,\s*\}/
  );
  assert.doesNotMatch(
    dashboardPayoutsRouteSource,
    /req\.(?:query|body)\.organizationId/
  );
});

test("host payout transactions expose actual Stripe financial evidence only from Direct Charge balance evidence", () => {
  assert.match(
    dashboardPayoutsRouteSource,
    /financialEvidence\.chargeMode === "DIRECT_CHARGE"[\s\S]*?financialEvidence\.source === "STRIPE_BALANCE_TRANSACTION"/
  );
  assert.match(
    dashboardPayoutsRouteSource,
    /stripeProcessingFeeAmount = hasActualDirectChargeEvidence[\s\S]*?money\(financialEvidence\.stripeProcessingFeeAmount\)[\s\S]*?: null/
  );
  assert.match(
    dashboardPayoutsRouteSource,
    /stripeProcessingFeeActual: stripeProcessingFeeAmount !== null/
  );
  assert.match(
    dashboardPayoutsRouteSource,
    /applicationFeeAmount = hasActualDirectChargeEvidence[\s\S]*?money\(financialEvidence\.applicationFeeAmount\)[\s\S]*?: null/
  );
  assert.match(
    dashboardPayoutsRouteSource,
    /applicationFeeActual: applicationFeeAmount !== null/
  );
});
