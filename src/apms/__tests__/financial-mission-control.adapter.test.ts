import assert from "node:assert/strict";
import test from "node:test";

import {
  mapFinancialMissionControlOperationalItems,
} from "../financial-mission-control.adapter";
import type {
  FinancialMissionControlInput,
} from "../financial-mission-control.adapter";

const SIGNAL_AT = new Date(
  "2026-07-24T12:00:00.000Z"
);

function createInput(
  overrides: Partial<
    FinancialMissionControlInput
  > = {}
): FinancialMissionControlInput {
  return {
    publicBookingEnabled: true,
    activeDirectBookingCount: 0,
    stripePlatformConfigured: true,
    stripeConnectAccountId:
      "acct_test_ready",
    stripeConnectStatus: "READY",
    stripeConnectChargesEnabled: true,
    stripeConnectPayoutsEnabled: true,
    stripeConnectDisabledReason: null,
    stripeConnectLastSyncedAt: null,
    signalAt: SIGNAL_AT,
    ...overrides,
  };
}

test("returns no workflow when Financial is not applicable", () => {
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        publicBookingEnabled: false,
        activeDirectBookingCount: 0,
        stripeConnectAccountId: null,
        stripeConnectStatus:
          "NOT_CONNECTED",
        stripeConnectChargesEnabled:
          false,
        stripeConnectPayoutsEnabled:
          false,
      })
    );

  assert.deepEqual(items, []);
});

test("keeps Financial not applicable when an unused Connect account remains stored", () => {
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        publicBookingEnabled: false,
        activeDirectBookingCount: 0,
        stripeConnectAccountId:
          "acct_unused",
        stripeConnectStatus:
          "RESTRICTED",
        stripeConnectChargesEnabled:
          false,
        stripeConnectPayoutsEnabled:
          false,
        stripeConnectDisabledReason:
          "requirements.past_due",
      })
    );

  assert.deepEqual(items, []);
});

test("returns no workflow when Stripe payouts are fully ready", () => {
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput()
    );

  assert.deepEqual(items, []);
});

test("maps missing Stripe platform credentials to host action", () => {
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        stripePlatformConfigured: false,
      })
    );

  assert.equal(items.length, 1);
  assert.equal(
    items[0]?.issueCode,
    "FINANCIAL_STRIPE_PLATFORM_NOT_CONFIGURED"
  );
  assert.equal(
    items[0]?.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(
    items[0]?.responsibleActor,
    "HOST"
  );
});

test("maps pending verification to automatic waiting without host action", () => {
  const lastSyncedAt = new Date(
    "2026-07-24T11:55:00.000Z"
  );
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        stripeConnectStatus:
          "PENDING_VERIFICATION",
        stripeConnectChargesEnabled:
          false,
        stripeConnectPayoutsEnabled:
          false,
        stripeConnectLastSyncedAt:
          lastSyncedAt,
      })
    );

  assert.equal(items.length, 1);
  assert.equal(
    items[0]?.issueCode,
    "FINANCIAL_PAYOUT_VERIFICATION_PENDING"
  );
  assert.equal(
    items[0]?.workflowState,
    "WAITING"
  );
  assert.equal(
    items[0]?.actionRequired,
    false
  );
  assert.equal(
    items[0]?.responsibleActor,
    "SYSTEM"
  );
  assert.equal(
    items[0]?.actionTarget,
    "PAYMENT"
  );
  assert.equal(
    items[0]?.lastSignalAt,
    lastSyncedAt
  );
  assert.match(
    String(
      items[0]?.nextAutomaticStep
    ),
    /automatically/i
  );
});

test("maps missing Stripe connection to host action", () => {
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        stripeConnectAccountId: null,
        stripeConnectStatus:
          "NOT_CONNECTED",
        stripeConnectChargesEnabled:
          false,
        stripeConnectPayoutsEnabled:
          false,
      })
    );

  assert.equal(items.length, 1);
  assert.equal(
    items[0]?.issueCode,
    "FINANCIAL_PAYOUT_ACCOUNT_NOT_CONNECTED"
  );
  assert.equal(
    items[0]?.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(
    items[0]?.actionRequired,
    true
  );
  assert.equal(
    items[0]?.responsibleActor,
    "HOST"
  );
  assert.match(
    String(items[0]?.recommendedAction),
    /connect/i
  );
});

test("maps incomplete onboarding to host action", () => {
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        stripeConnectStatus:
          "ONBOARDING_REQUIRED",
        stripeConnectChargesEnabled:
          false,
        stripeConnectPayoutsEnabled:
          false,
      })
    );

  assert.equal(
    items[0]?.issueCode,
    "FINANCIAL_PAYOUT_ONBOARDING_REQUIRED"
  );
  assert.equal(
    items[0]?.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(
    items[0]?.responsibleActor,
    "HOST"
  );
});

test("maps restricted Stripe account to host action with safe reason", () => {
  const disabledReason =
    "requirements.past_due";
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        stripeConnectStatus: "RESTRICTED",
        stripeConnectChargesEnabled:
          false,
        stripeConnectPayoutsEnabled:
          false,
        stripeConnectDisabledReason:
          disabledReason,
      })
    );

  assert.equal(
    items[0]?.issueCode,
    "FINANCIAL_PAYOUT_ACCOUNT_RESTRICTED"
  );
  assert.equal(
    items[0]?.workflowState,
    "ACTION_REQUIRED"
  );
  assert.match(
    String(items[0]?.issue),
    new RegExp(disabledReason)
  );
});

test("maps inconsistent READY capabilities to host action", () => {
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        stripeConnectStatus: "READY",
        stripeConnectChargesEnabled: true,
        stripeConnectPayoutsEnabled:
          false,
      })
    );

  assert.equal(
    items[0]?.issueCode,
    "FINANCIAL_PAYOUT_ACCOUNT_NOT_READY"
  );
  assert.equal(
    items[0]?.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(
    items[0]?.responsibleActor,
    "HOST"
  );
});

test("maps unknown provider state to automatic reconciliation", () => {
  const items =
    mapFinancialMissionControlOperationalItems(
      createInput({
        stripeConnectStatus: "UNKNOWN",
        stripeConnectChargesEnabled:
          false,
        stripeConnectPayoutsEnabled:
          false,
      })
    );

  assert.equal(
    items[0]?.issueCode,
    "FINANCIAL_PAYOUT_STATUS_SYNC_PENDING"
  );
  assert.equal(
    items[0]?.workflowState,
    "WAITING"
  );
  assert.equal(
    items[0]?.actionRequired,
    false
  );
  assert.equal(
    items[0]?.responsibleActor,
    "SYSTEM"
  );
});
