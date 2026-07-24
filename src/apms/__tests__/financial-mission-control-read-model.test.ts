import assert from "node:assert/strict";
import test from "node:test";

import {
  APMS_ENGINE_IDS,
} from "../engine-operational-contract";
import type {
  ApmsEngineId,
} from "../engine-operational-contract";
import {
  mapFinancialMissionControlOperationalItems,
} from "../financial-mission-control.adapter";
import {
  buildMissionControlReadModel,
} from "../mission-control-read-model";
import type {
  MissionControlEngineReadiness,
} from "../mission-control-read-model";

const GENERATED_AT = new Date(
  "2026-07-24T12:00:00.000Z"
);

function createReadiness(
  financial: Partial<
    MissionControlEngineReadiness
  >
) {
  return Object.fromEntries(
    APMS_ENGINE_IDS.map((engineId) => [
      engineId,
      {
        enabled: true,
        configured: true,
        applicable: true,
        reasonCode:
          `${engineId}_HEALTHY`,
        summary:
          `${engineId} is healthy.`,
        dependencies: [],
        evidenceRefs: [],
        ...(engineId === "FINANCIAL"
          ? financial
          : {}),
      },
    ])
  ) as Record<
    ApmsEngineId,
    MissionControlEngineReadiness
  >;
}

function getFinancialEngine(
  model: ReturnType<
    typeof buildMissionControlReadModel
  >
) {
  const financial = model.engines.find(
    (engine) =>
      engine.engineId === "FINANCIAL"
  );

  assert.ok(financial);
  return financial;
}

test("keeps Financial gray when Direct Booking is not applicable", () => {
  const operationalItems =
    mapFinancialMissionControlOperationalItems({
      publicBookingEnabled: false,
      activeDirectBookingCount: 0,
      stripePlatformConfigured: true,
      stripeConnectAccountId:
        "acct_unused",
      stripeConnectStatus: "RESTRICTED",
      stripeConnectChargesEnabled: false,
      stripeConnectPayoutsEnabled: false,
      stripeConnectDisabledReason:
        "requirements.past_due",
      stripeConnectLastSyncedAt:
        GENERATED_AT,
      signalAt: GENERATED_AT,
    });

  const model =
    buildMissionControlReadModel({
      organizationId: "org-test",
      generatedAt: GENERATED_AT,
      readiness: createReadiness({
        enabled: false,
        configured: false,
        applicable: false,
        reasonCode:
          "FINANCIAL_NOT_APPLICABLE",
        summary:
          "Financial is not applicable.",
      }),
      operationalItems,
    });

  const financial =
    getFinancialEngine(model);

  assert.deepEqual(operationalItems, []);
  assert.equal(
    financial.state,
    "DISABLED"
  );
  assert.equal(
    financial.hostActionRequired,
    false
  );
  assert.equal(model.needsHostAction, false);
  assert.equal(model.hostActionCount, 0);
  assert.equal(model.autoResolvingCount, 0);
});

test("keeps pending Stripe verification blue while automatic webhook reconciliation remains available", () => {
  const operationalItems =
    mapFinancialMissionControlOperationalItems({
      publicBookingEnabled: true,
      activeDirectBookingCount: 0,
      stripePlatformConfigured: true,
      stripeConnectAccountId:
        "acct_pending",
      stripeConnectStatus:
        "PENDING_VERIFICATION",
      stripeConnectChargesEnabled: false,
      stripeConnectPayoutsEnabled: false,
      stripeConnectDisabledReason: null,
      stripeConnectLastSyncedAt:
        GENERATED_AT,
      signalAt: GENERATED_AT,
    });

  const model =
    buildMissionControlReadModel({
      organizationId: "org-test",
      generatedAt: GENERATED_AT,
      readiness: createReadiness({
        enabled: true,
        configured: false,
        applicable: true,
        reasonCode:
          "FINANCIAL_NOT_CONFIGURED",
        summary:
          "Stripe verification is pending.",
      }),
      operationalItems,
    });

  const financial =
    getFinancialEngine(model);

  assert.equal(
    financial.state,
    "AUTO_RESOLVING"
  );
  assert.equal(
    financial.hostActionRequired,
    false
  );
  assert.equal(financial.autoResolvingCount, 1);
  assert.equal(model.needsHostAction, false);
  assert.equal(model.hostActionCount, 0);
  assert.equal(model.autoResolvingCount, 1);
  assert.equal(
    model.automaticWork[0]?.issueCode,
    "FINANCIAL_PAYOUT_VERIFICATION_PENDING"
  );
  assert.match(
    String(financial.nextAutomaticStep),
    /account update/i
  );
});

test("turns missing Stripe platform configuration red when Financial is applicable", () => {
  const operationalItems =
    mapFinancialMissionControlOperationalItems({
      publicBookingEnabled: true,
      activeDirectBookingCount: 0,
      stripePlatformConfigured: false,
      stripeConnectAccountId:
        "acct_ready",
      stripeConnectStatus: "READY",
      stripeConnectChargesEnabled: true,
      stripeConnectPayoutsEnabled: true,
      stripeConnectDisabledReason: null,
      stripeConnectLastSyncedAt:
        GENERATED_AT,
      signalAt: GENERATED_AT,
    });

  const model =
    buildMissionControlReadModel({
      organizationId: "org-test",
      generatedAt: GENERATED_AT,
      readiness: createReadiness({
        enabled: true,
        configured: false,
        applicable: true,
        reasonCode:
          "FINANCIAL_NOT_CONFIGURED",
        summary:
          "Stripe platform configuration is missing.",
      }),
      operationalItems,
    });

  const financial =
    getFinancialEngine(model);

  assert.equal(
    financial.state,
    "HOST_ACTION_REQUIRED"
  );
  assert.equal(
    financial.hostActionRequired,
    true
  );
  assert.equal(financial.hostActionCount, 1);
  assert.equal(model.needsHostAction, true);
  assert.equal(model.hostActionCount, 1);
  assert.equal(model.autoResolvingCount, 0);
  assert.equal(
    model.hostActions[0]?.issueCode,
    "FINANCIAL_STRIPE_PLATFORM_NOT_CONFIGURED"
  );
});
