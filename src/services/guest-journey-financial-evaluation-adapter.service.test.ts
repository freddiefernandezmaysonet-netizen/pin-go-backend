import assert from "node:assert/strict";
import test from "node:test";

import {
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import { executeGuestJourneyFinancialEvaluationAdapter } from "./guest-journey-financial-evaluation-adapter.service";
import type { ClaimedFinancialIntent } from "./guest-journey-financial-owner-runtime.service";

function claim(): ClaimedFinancialIntent {
  return {
    intentId: "intent-1",
    intentKey: "key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    organizationId: "org-1",
    propertyId: "property-1",
    targetEngine: "FINANCIAL",
    intentType: "REQUEST_PAYMENT_EVALUATION",
    expectedOutcomeCode: "PAYMENT_STATE_RESOLVED",
    inputEvidenceFingerprint: "input",
    attemptNumber: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date("2026-08-24T12:05:00.000Z"),
  };
}

function reservation(input: {
  status?: ReservationStatus;
  source?: string | null;
  externalProvider?: string | null;
  paymentState?: PaymentState;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  propertyId?: string;
  organizationId?: string;
} = {}) {
  const stripeCheckoutSessionId =
    "stripeCheckoutSessionId" in input
      ? input.stripeCheckoutSessionId
      : "cs_123";
  const stripePaymentIntentId =
    "stripePaymentIntentId" in input
      ? input.stripePaymentIntentId
      : "pi_123";
  return {
    id: "reservation-1",
    propertyId: input.propertyId ?? "property-1",
    status: input.status ?? ReservationStatus.ACTIVE,
    source: input.source ?? "DIRECT_BOOKING",
    externalProvider: input.externalProvider ?? "PIN_GO_DIRECT",
    paymentState: input.paymentState ?? PaymentState.PAID,
    totalAmount: 125,
    amountCollected: 125,
    amountRefunded: 0,
    currency: "usd",
    stripeCheckoutSessionId,
    stripePaymentIntentId,
    stripeChargeId: "ch_123",
    stripeTransferId: "tr_123",
    stripeApplicationFeeId: "fee_123",
    stripeConnectedAccountId: "acct_123",
    hostPayoutAmount: 100,
    hostPayoutStatus: "ROUTED_TO_CONNECT",
    hostPayoutFailureReason: null,
    hostPayoutLastSyncedAt: new Date("2026-08-24T12:00:00.000Z"),
    property: {
      organizationId: input.organizationId ?? "org-1",
    },
  };
}

function fakePrisma(snapshot: ReturnType<typeof reservation>) {
  return {
    reservation: {
      findUnique: async () => snapshot,
    },
  } as any;
}

test("E9 adapter succeeds when persisted payment evidence is already satisfied", async () => {
  const result = await executeGuestJourneyFinancialEvaluationAdapter(
    fakePrisma(reservation()),
    claim()
  );
  assert.equal(result.providerCalls, 0);
  assert.equal(result.completion.kind, "SUCCEEDED");
  if (result.completion.kind === "SUCCEEDED") {
    assert.equal(result.completion.action, "PAYMENT_ALREADY_SATISFIED");
    assert.equal(result.completion.paymentState, PaymentState.PAID);
  }
});

test("E9 adapter waits without charging when payment is not persisted", async () => {
  const result = await executeGuestJourneyFinancialEvaluationAdapter(
    fakePrisma(reservation({ paymentState: PaymentState.NONE })),
    claim()
  );
  assert.equal(result.providerCalls, 0);
  assert.equal(result.completion.kind, "WAITING_FOR_EVIDENCE");
  if (result.completion.kind === "WAITING_FOR_EVIDENCE") {
    assert.equal(result.completion.errorCode, "PAYMENT_EVIDENCE_NOT_YET_SATISFIED");
  }
});

test("E9 adapter fences direct booking PAID records missing Stripe evidence", async () => {
  const result = await executeGuestJourneyFinancialEvaluationAdapter(
    fakePrisma(reservation({
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: "pi_123",
    })),
    claim()
  );
  assert.equal(result.providerCalls, 0);
  assert.equal(result.completion.kind, "EXHAUSTED");
  if (result.completion.kind === "EXHAUSTED") {
    assert.equal(
      result.completion.errorCode,
      "FINANCIAL_DIRECT_BOOKING_STRIPE_EVIDENCE_INCOMPLETE"
    );
  }
});

test("E9 adapter resolves stale terminal reservations without money movement", async () => {
  const result = await executeGuestJourneyFinancialEvaluationAdapter(
    fakePrisma(reservation({
      status: ReservationStatus.CANCELLED,
      paymentState: PaymentState.NONE,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
    })),
    claim()
  );
  assert.equal(result.providerCalls, 0);
  assert.equal(result.completion.kind, "SUCCEEDED");
  if (result.completion.kind === "SUCCEEDED") {
    assert.equal(
      result.completion.action,
      "PAYMENT_NOT_REQUIRED_FOR_TERMINAL_RESERVATION"
    );
  }
});

test("E9 adapter fails closed on scope and handler drift", async () => {
  await assert.rejects(
    executeGuestJourneyFinancialEvaluationAdapter(
      fakePrisma(reservation({ organizationId: "other" })),
      claim()
    ),
    /FINANCIAL_ADAPTER_SCOPE_MISMATCH/
  );
  await assert.rejects(
    executeGuestJourneyFinancialEvaluationAdapter(
      fakePrisma(reservation()),
      { ...claim(), targetEngine: "ACCESS" as never }
    ),
    /FINANCIAL_ADAPTER_CONTRACT_MISMATCH/
  );
});
