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
