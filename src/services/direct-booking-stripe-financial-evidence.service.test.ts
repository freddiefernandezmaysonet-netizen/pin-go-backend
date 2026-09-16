import assert from "node:assert/strict";
import test from "node:test";
import { extractDirectBookingStripeFinancialEvidence } from "./direct-booking-stripe-financial-evidence.service.js";

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

test("legacy destination transfer reference remains available", () => {
  const paymentIntent = {
    id: "pi_legacy",
    application_fee_amount: 100,
    latest_charge: {
      id: "ch_legacy",
      object: "charge",
      transfer: { id: "tr_legacy" },
      application_fee: "fee_legacy",
      balance_transaction: null,
    },
  } as any;

  const evidence = extractDirectBookingStripeFinancialEvidence(paymentIntent);
  assert.equal(evidence.stripeTransferId, "tr_legacy");
  assert.equal(evidence.stripeChargeId, "ch_legacy");
  assert.equal(evidence.stripeApplicationFeeId, "fee_legacy");
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
