import test from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

import {
  claimStripeFinancialEvent,
  isStripeFinancialLedgerEventType,
  markStripeFinancialEventFailed,
  markStripeFinancialEventProcessed,
} from "./stripe-financial-event-ledger.service";

function stripeEvent(input: {
  id?: string;
  type: string;
  livemode?: boolean;
}): Stripe.Event {
  return {
    id: input.id ?? "evt_test_123",
    object: "event",
    api_version: "2025-06-30.basil",
    created: 1,
    data: {
      object: {
        id: "obj_123",
        object: "charge",
      } as any,
    },
    livemode: input.livemode ?? true,
    pending_webhooks: 1,
    request: null,
    type: input.type as Stripe.Event.Type,
  } as Stripe.Event;
}

function makeDb(initial?: {
  stripeId: string;
  type: string;
  livemode: boolean;
  payload: any;
  processedAt: Date | null;
  error: string | null;
}) {
  let row = initial ? { ...initial } : null;

  const stripeEventLog = {
    create: async ({ data }: any) => {
      if (row?.stripeId === data.stripeId) {
        const error: any = new Error("unique");
        error.code = "P2002";
        throw error;
      }
      row = { ...data };
      return row;
    },
    findUnique: async ({ where }: any) => {
      if (!row || row.stripeId !== where.stripeId) return null;
      return {
        processedAt: row.processedAt,
        error: row.error,
        payload: row.payload,
      };
    },
    updateMany: async ({ where, data }: any) => {
      if (
        !row ||
        row.stripeId !== where.stripeId ||
        row.processedAt !== null ||
        row.error === null
      ) {
        return { count: 0 };
      }
      row = { ...row, ...data };
      return { count: 1 };
    },
    update: async ({ where, data }: any) => {
      assert.ok(row && row.stripeId === where.stripeId);
      row = { ...row, ...data };
      return row;
    },
  };

  return {
    db: { stripeEventLog } as any,
    getRow: () => row,
  };
}

test("financial classifier tracks money events and excludes Stripe Identity", () => {
  for (const type of [
    "checkout.session.completed",
    "customer.subscription.updated",
    "invoice.paid",
    "payment_intent.succeeded",
    "charge.refunded",
    "charge.dispute.created",
    "refund.created",
    "application_fee.created",
    "transfer.created",
    "payout.paid",
  ]) {
    assert.equal(isStripeFinancialLedgerEventType(type), true, type);
  }

  assert.equal(
    isStripeFinancialLedgerEventType(
      "identity.verification_session.verified"
    ),
    false
  );
});

test("new financial event is persisted and claimed for processing", async () => {
  const { db, getRow } = makeDb();
  const event = stripeEvent({ type: "invoice.paid" });

  const claim = await claimStripeFinancialEvent(db, event);

  assert.deepEqual(claim, {
    tracked: true,
    shouldProcess: true,
    reason: "NEW",
  });
  assert.equal(getRow()?.stripeId, event.id);
  assert.equal(getRow()?.type, event.type);
  assert.equal(getRow()?.livemode, true);
  assert.equal(getRow()?.processedAt, null);
  assert.equal(getRow()?.error, null);
});

test("processed duplicate is acknowledged without reprocessing", async () => {
  const { db } = makeDb({
    stripeId: "evt_test_123",
    type: "invoice.paid",
    livemode: true,
    payload: {},
    processedAt: new Date("2026-09-15T20:00:00.000Z"),
    error: null,
  });

  const claim = await claimStripeFinancialEvent(
    db,
    stripeEvent({ type: "invoice.paid" })
  );

  assert.deepEqual(claim, {
    tracked: true,
    shouldProcess: false,
    reason: "DUPLICATE_PROCESSED",
  });
});

test("concurrent in-progress duplicate is acknowledged without double execution", async () => {
  const { db } = makeDb({
    stripeId: "evt_test_123",
    type: "charge.succeeded",
    livemode: true,
    payload: {},
    processedAt: null,
    error: null,
  });

  const claim = await claimStripeFinancialEvent(
    db,
    stripeEvent({ type: "charge.succeeded" })
  );

  assert.equal(claim.shouldProcess, false);
  assert.equal(claim.reason, "DUPLICATE_IN_PROGRESS");
});

test("failed financial event can be reclaimed on Stripe retry", async () => {
  const { db, getRow } = makeDb({
    stripeId: "evt_test_123",
    type: "invoice.payment_failed",
    livemode: true,
    payload: { old: true },
    processedAt: null,
    error: "temporary failure",
  });

  const claim = await claimStripeFinancialEvent(
    db,
    stripeEvent({ type: "invoice.payment_failed" })
  );

  assert.deepEqual(claim, {
    tracked: true,
    shouldProcess: true,
    reason: "RETRY",
  });
  assert.equal(getRow()?.error, null);
});

test("non-financial event is not persisted but continues through existing webhook", async () => {
  const { db, getRow } = makeDb();

  const claim = await claimStripeFinancialEvent(
    db,
    stripeEvent({
      type: "identity.verification_session.verified",
    })
  );

  assert.deepEqual(claim, {
    tracked: false,
    shouldProcess: true,
    reason: "NOT_FINANCIAL",
  });
  assert.equal(getRow(), null);
});

test("processed and failed markers update the existing ledger row", async () => {
  const { db, getRow } = makeDb({
    stripeId: "evt_test_123",
    type: "transfer.created",
    livemode: true,
    payload: {},
    processedAt: null,
    error: null,
  });

  const processedAt = new Date("2026-09-15T21:00:00.000Z");
  await markStripeFinancialEventProcessed(
    db,
    "evt_test_123",
    processedAt
  );
  assert.equal(getRow()?.processedAt, processedAt);
  assert.equal(getRow()?.error, null);

  await markStripeFinancialEventFailed(
    db,
    "evt_test_123",
    new Error("x".repeat(2500))
  );
  assert.equal(getRow()?.processedAt, null);
  assert.equal(getRow()?.error?.length, 2000);
});

test("legacy Direct Booking ledger completion does not touch reservation or Stripe reconciliation", async () => {
  const legacyEvent = {
    id: "evt_legacy",
    object: "event",
    type: "checkout.session.completed",
    livemode: true,
    data: {
      object: {
        id: "cs_legacy",
        object: "checkout.session",
        metadata: {
          flow: "direct_booking",
        },
      },
    },
  } as any;
  const { db, getRow } = makeDb({
    stripeId: legacyEvent.id,
    type: legacyEvent.type,
    livemode: true,
    payload: legacyEvent,
    processedAt: null,
    error: null,
  });
  let reservationRead = false;
  let reservationWrite = false;
  let stripeRead = false;
  const processedAt = new Date("2026-09-16T21:00:00.000Z");

  await markStripeFinancialEventProcessed(
    {
      ...db,
      reservation: {
        async findUnique() {
          reservationRead = true;
          return null;
        },
        async update() {
          reservationWrite = true;
          return null;
        },
      },
    } as any,
    legacyEvent.id,
    processedAt,
    {
      stripeClient: {
        paymentIntents: {
          async retrieve() {
            stripeRead = true;
            return {} as any;
          },
        },
      },
    }
  );

  assert.equal(reservationRead, false);
  assert.equal(reservationWrite, false);
  assert.equal(stripeRead, false);
  assert.equal(getRow()?.processedAt, processedAt);
});

test("Direct Charge ledger completion reconciles host financial evidence before marking processed", async () => {
  const directEvent = {
    id: "evt_direct",
    object: "event",
    type: "checkout.session.completed",
    livemode: true,
    account: "acct_host",
    data: {
      object: {
        id: "cs_direct",
        object: "checkout.session",
        payment_intent: "pi_direct",
        metadata: {
          flow: "direct_booking",
          stripeChargeMode: "DIRECT_CHARGE",
          stripeConnectedAccountId: "acct_host",
        },
      },
    },
  } as any;
  const { db, getRow } = makeDb({
    stripeId: directEvent.id,
    type: directEvent.type,
    livemode: true,
    payload: directEvent,
    processedAt: null,
    error: null,
  });
  const updates: any[] = [];
  const processedAt = new Date("2026-09-16T21:05:00.000Z");

  await markStripeFinancialEventProcessed(
    {
      ...db,
      reservation: {
        async findUnique() {
          return {
            id: "res_direct",
            stripePaymentIntentId: "pi_direct",
            stripeConnectedAccountId: "acct_host",
            stripeChargeId: null,
            stripeTransferId: null,
            stripeApplicationFeeId: null,
            hostPayoutAmount: 9,
            externalRaw: {},
          };
        },
        async update(args: any) {
          assert.equal(getRow()?.processedAt, null);
          updates.push(args);
          return args;
        },
      },
    } as any,
    directEvent.id,
    processedAt,
    {
      stripeClient: {
        paymentIntents: {
          async retrieve(...args: any[]) {
            if (args.length < 3) {
              const error: any = new Error("No such payment_intent");
              error.code = "resource_missing";
              throw error;
            }

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
    }
  );

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.hostPayoutAmount, 8.18);
  assert.equal(
    updates[0].data.externalRaw.stripeFinancialEvidence.stripeProcessingFeeAmount,
    0.59
  );
  assert.equal(getRow()?.processedAt, processedAt);
  assert.equal(getRow()?.error, null);
});
