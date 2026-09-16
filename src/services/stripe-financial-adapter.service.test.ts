import test from "node:test";
import assert from "node:assert/strict";

import { getStripeFinancialActuals } from "./stripe-financial-adapter.service";

const SINCE = new Date("2026-08-16T00:00:00.000Z");
const NOW = new Date("2026-09-15T23:59:59.000Z");

function ledgerEvent(input: {
  stripeId: string;
  type: string;
  object: Record<string, unknown>;
  livemode?: boolean;
  created?: number;
}) {
  const created =
    input.created ??
    Math.floor(new Date("2026-09-10T12:00:00.000Z").getTime() / 1000);

  return {
    stripeId: input.stripeId,
    type: input.type,
    livemode: input.livemode ?? true,
    createdAt: new Date(created * 1000),
    payload: {
      id: input.stripeId,
      object: "event",
      created,
      livemode: input.livemode ?? true,
      type: input.type,
      data: {
        object: input.object,
      },
    },
  };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: "res_1",
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    currency: "usd",
    amountCollected: 100,
    amountRefunded: 0,
    stripeCheckoutSessionId: "cs_1",
    stripePaymentIntentId: "pi_1",
    stripeChargeId: "ch_1",
    stripeTransferId: "tr_1",
    stripeApplicationFeeId: "fee_1",
    basePlatformFeeAmount: 10,
    platformFeeAmount: 10,
    hostPayoutAmount: 90,
    externalRaw: null,
    ...overrides,
  };
}

function makeDb(input: {
  ledger?: ReturnType<typeof ledgerEvent>[];
  reservations?: ReturnType<typeof reservation>[];
}) {
  return {
    stripeEventLog: {
      findMany: async () => input.ledger ?? [],
    },
    reservation: {
      findMany: async () => input.reservations ?? [],
    },
  } as any;
}

test("aggregates Stripe actuals and avoids Reservation double counting", async () => {
  const db = makeDb({
    ledger: [
      ledgerEvent({
        stripeId: "evt_invoice",
        type: "invoice.paid",
        object: {
          id: "in_1",
          object: "invoice",
          amount_paid: 2498,
          currency: "usd",
        },
      }),
      ledgerEvent({
        stripeId: "evt_fee",
        type: "application_fee.refunded",
        object: {
          id: "fee_1",
          object: "application_fee",
          amount: 1000,
          amount_refunded: 200,
          currency: "usd",
        },
      }),
      ledgerEvent({
        stripeId: "evt_checkout",
        type: "checkout.session.completed",
        object: {
          id: "cs_1",
          object: "checkout.session",
          amount_total: 10000,
          currency: "usd",
          payment_status: "paid",
          metadata: { flow: "direct_booking" },
        },
      }),
      ledgerEvent({
        stripeId: "evt_transfer",
        type: "transfer.created",
        object: {
          id: "tr_1",
          object: "transfer",
          amount: 9000,
          currency: "usd",
        },
      }),
      ledgerEvent({
        stripeId: "evt_refund",
        type: "refund.created",
        object: {
          id: "re_1",
          object: "refund",
          amount: 2000,
          currency: "usd",
          status: "succeeded",
          charge: "ch_1",
          payment_intent: "pi_1",
        },
      }),
      ledgerEvent({
        stripeId: "evt_dispute",
        type: "charge.dispute.created",
        object: {
          id: "dp_1",
          object: "dispute",
          amount: 3000,
          currency: "usd",
          charge: "ch_1",
        },
      }),
    ],
    reservations: [
      reservation({
        amountRefunded: 20,
        hostPayoutAmount: 90,
        externalRaw: {
          refund: {
            stripeRefundId: "re_1",
          },
        },
      }),
    ],
  });

  const actuals = await getStripeFinancialActuals(db, {
    since: SINCE,
    now: NOW,
  });

  assert.deepEqual(actuals, {
    saasRevenueActual: 24.98,
    connectPlatformFeesActual: 8,
    guestBookingGmv: 100,
    hostTransfers: 90,
    refunds: 20,
    disputes: 30,
    stripeProcessingFeesActual: null,
    netPlatformRevenue: null,
    reconciliationStatus: "REQUIRES_BALANCE_TRANSACTION_RECONCILIATION",
    ledgerEventCount: 6,
    livemode: true,
  });
});

test("uses Direct Booking Reservation evidence as fallback when ledger operation is absent", async () => {
  const db = makeDb({
    ledger: [
      ledgerEvent({
        stripeId: "evt_invoice_only",
        type: "invoice.paid",
        object: {
          id: "in_2",
          object: "invoice",
          amount_paid: 1249,
          currency: "usd",
        },
      }),
    ],
    reservations: [
      reservation({
        id: "res_fallback",
        stripeCheckoutSessionId: "cs_fallback",
        stripePaymentIntentId: "pi_fallback",
        stripeChargeId: "ch_fallback",
        stripeTransferId: "tr_fallback",
        stripeApplicationFeeId: "fee_fallback",
        amountCollected: 125,
        amountRefunded: 25,
        basePlatformFeeAmount: 15,
        platformFeeAmount: 17,
        hostPayoutAmount: 110,
      }),
    ],
  });

  const actuals = await getStripeFinancialActuals(db, {
    since: SINCE,
    now: NOW,
  });

  assert.equal(actuals.saasRevenueActual, 12.49);
  assert.equal(actuals.guestBookingGmv, 125);
  assert.equal(actuals.connectPlatformFeesActual, 15);
  assert.equal(actuals.hostTransfers, 110);
  assert.equal(actuals.refunds, 25);
});

test("reconciles Reservation refund fallback only for the amount not already in the ledger", async () => {
  const db = makeDb({
    ledger: [
      ledgerEvent({
        stripeId: "evt_partial_refund",
        type: "refund.created",
        object: {
          id: "re_partial",
          object: "refund",
          amount: 1000,
          currency: "usd",
          status: "succeeded",
          charge: "ch_1",
          payment_intent: "pi_1",
        },
      }),
    ],
    reservations: [
      reservation({
        amountRefunded: 25,
      }),
    ],
  });

  const actuals = await getStripeFinancialActuals(db, {
    since: SINCE,
    now: NOW,
  });

  assert.equal(actuals.refunds, 25);
});

test("prefers live ledger rows over test rows and flags mixed livemode", async () => {
  const db = makeDb({
    ledger: [
      ledgerEvent({
        stripeId: "evt_live",
        type: "invoice.paid",
        livemode: true,
        object: {
          id: "in_live",
          object: "invoice",
          amount_paid: 100,
          currency: "usd",
        },
      }),
      ledgerEvent({
        stripeId: "evt_test",
        type: "invoice.paid",
        livemode: false,
        object: {
          id: "in_test",
          object: "invoice",
          amount_paid: 99900,
          currency: "usd",
        },
      }),
    ],
  });

  const actuals = await getStripeFinancialActuals(db, {
    since: SINCE,
    now: NOW,
  });

  assert.equal(actuals.saasRevenueActual, 1);
  assert.equal(actuals.livemode, true);
  assert.equal(actuals.ledgerEventCount, 1);
  assert.equal(
    actuals.reconciliationStatus,
    "REQUIRES_LIVEMODE_RECONCILIATION"
  );
});

test("does not invent Stripe processing fees from a balance transaction id", async () => {
  const db = makeDb({
    ledger: [
      ledgerEvent({
        stripeId: "evt_charge",
        type: "charge.succeeded",
        object: {
          id: "ch_fee_unknown",
          object: "charge",
          amount: 10000,
          currency: "usd",
          balance_transaction: "txn_123",
        },
      }),
    ],
  });

  const actuals = await getStripeFinancialActuals(db, {
    since: SINCE,
    now: NOW,
  });

  assert.equal(actuals.stripeProcessingFeesActual, null);
  assert.equal(actuals.netPlatformRevenue, null);
  assert.equal(
    actuals.reconciliationStatus,
    "REQUIRES_BALANCE_TRANSACTION_RECONCILIATION"
  );
});

test("returns an explicit empty-state reconciliation status", async () => {
  const actuals = await getStripeFinancialActuals(makeDb({}), {
    since: SINCE,
    now: NOW,
  });

  assert.deepEqual(actuals, {
    saasRevenueActual: 0,
    connectPlatformFeesActual: 0,
    guestBookingGmv: 0,
    hostTransfers: 0,
    refunds: 0,
    disputes: 0,
    stripeProcessingFeesActual: null,
    netPlatformRevenue: null,
    reconciliationStatus: "NO_FINANCIAL_ACTIVITY",
    ledgerEventCount: 0,
    livemode: null,
  });
});
