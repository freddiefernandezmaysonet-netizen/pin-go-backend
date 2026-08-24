import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GuestJourneyState } from "@prisma/client";

import {
  CANONICAL_GUEST_JOURNEY_STATE_ORDER,
  GUEST_JOURNEY_COORDINATION_INTENT_TYPES,
  GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
  GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE,
  GUEST_JOURNEY_ACCESS_OWNER_VERSION,
  GUEST_JOURNEY_ACCESS_PROVISIONING_HANDLER_CODE,
  GUEST_JOURNEY_ACCESS_REVOCATION_HANDLER_CODE,
  GUEST_JOURNEY_COMMUNICATIONS_HANDLER_CODE,
  GUEST_JOURNEY_COMMUNICATIONS_OWNER_VERSION,
  GUEST_JOURNEY_FINANCIAL_OWNER_VERSION,
  GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_VERSION,
  GUEST_JOURNEY_MISSION_CONTROL_OPERATIONAL_ISSUE_CODE,
  GUEST_JOURNEY_OWNER_RUNTIME_VERSION,
  GUEST_JOURNEY_PAYMENT_EVALUATION_HANDLER_CODE,
  GUEST_JOURNEY_TARGET_ENGINES,
  TERMINAL_GUEST_JOURNEY_STATES,
  getCanonicalGuestJourneyStateRank,
  isTerminalGuestJourneyState,
} from "./guest-journey-contract.js";
import { isCanonicalEngineId } from "../apms/engine-catalog.js";

const lifecycleMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260818120000_extend_guest_journey_enterprise_lifecycle/migration.sql",
    import.meta.url
  ),
  "utf8"
);

const intentMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260818121000_add_guest_journey_enterprise_intents/migration.sql",
    import.meta.url
  ),
  "utf8"
);

const ownerRuntimeMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260822020000_add_guest_journey_owner_runtime/migration.sql",
    import.meta.url
  ),
  "utf8"
);

const communicationsEvidenceMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260823040000_add_guest_journey_communication_evidence/migration.sql",
    import.meta.url
  ),
  "utf8"
);

test("defines the complete forward and terminal Guest Journey lifecycle", () => {
  assert.deepEqual(
    CANONICAL_GUEST_JOURNEY_STATE_ORDER,
    [
      GuestJourneyState.RESERVATION_CONFIRMED,
      GuestJourneyState.VERIFICATION_PENDING,
      GuestJourneyState.VERIFICATION_COMPLETED,
      GuestJourneyState.ACCESS_SCHEDULED,
      GuestJourneyState.READY_FOR_ARRIVAL,
      GuestJourneyState.STAY_ACTIVE,
      GuestJourneyState.CHECKOUT_DUE,
      GuestJourneyState.JOURNEY_COMPLETED,
    ]
  );

  assert.deepEqual(
    TERMINAL_GUEST_JOURNEY_STATES,
    [
      GuestJourneyState.JOURNEY_COMPLETED,
      GuestJourneyState.JOURNEY_CANCELLED,
    ]
  );

  assert.equal(
    getCanonicalGuestJourneyStateRank(
      GuestJourneyState.JOURNEY_CANCELLED
    ),
    null
  );

  for (const state of TERMINAL_GUEST_JOURNEY_STATES) {
    assert.equal(isTerminalGuestJourneyState(state), true);
  }
});

test("permits only canonical owner Engine identifiers", () => {
  assert.deepEqual(
    GUEST_JOURNEY_TARGET_ENGINES,
    [
      "COMPLIANCE",
      "COMMUNICATIONS",
      "ACCESS",
      "FINANCIAL",
    ]
  );

  for (const engineId of GUEST_JOURNEY_TARGET_ENGINES) {
    assert.equal(isCanonicalEngineId(engineId), true);
  }

  for (const legacyName of [
    "Compliance",
    "Communications",
    "Access",
    "Financial",
    "Guest Journey",
  ]) {
    assert.equal(
      GUEST_JOURNEY_TARGET_ENGINES.includes(
        legacyName as never
      ),
      false
    );
  }
});

test("pins the durable coordination contract", () => {
  assert.equal(
    GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
    "guest_journey_coordination_intent_v1"
  );

  assert.deepEqual(
    GUEST_JOURNEY_COORDINATION_INTENT_TYPES,
    [
      "REQUEST_REQUIREMENTS_SNAPSHOT",
      "REQUEST_GUEST_VERIFICATION",
      "REQUEST_COMMUNICATION",
      "REQUEST_COMMUNICATION_RETRY",
      "REQUEST_ACCESS_EVALUATION",
      "REQUEST_ACCESS_PROVISIONING",
      "REQUEST_ACCESS_REVOCATION_CHECK",
      "REQUEST_PAYMENT_EVALUATION",
    ]
  );
});

test("pins the E5 owner runtime to ACCESS evaluation only", () => {
  assert.equal(
    GUEST_JOURNEY_OWNER_RUNTIME_VERSION,
    "guest_journey_owner_runtime_v1"
  );
  assert.equal(
    GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE,
    "ACCESS_EVALUATION_V1"
  );
  assert.match(
    ownerRuntimeMigration,
    /"targetEngine" = 'ACCESS'/
  );
  assert.match(
    ownerRuntimeMigration,
    /"intentType" = 'REQUEST_ACCESS_EVALUATION'/
  );
  assert.doesNotMatch(
    ownerRuntimeMigration,
    /\bDROP\s+(?:TABLE|COLUMN|TYPE|INDEX)\b/i
  );
  assert.doesNotMatch(
    ownerRuntimeMigration,
    /\bDELETE\s+FROM\b/i
  );
});

test("pins the E6 Mission Control bridge contract without expanding owner execution", () => {
  assert.equal(
    GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_VERSION,
    "guest_journey_mission_control_bridge_v1"
  );
  assert.equal(
    GUEST_JOURNEY_MISSION_CONTROL_OPERATIONAL_ISSUE_CODE,
    "GUEST_JOURNEY_OWNER_RUNTIME_STATUS"
  );
});

test("pins E7 to the canonical COMMUNICATIONS owner and additive delivery evidence", () => {
  assert.equal(
    GUEST_JOURNEY_COMMUNICATIONS_OWNER_VERSION,
    "guest_journey_communications_owner_v1"
  );
  assert.equal(
    GUEST_JOURNEY_COMMUNICATIONS_HANDLER_CODE,
    "COMMUNICATION_RETRY_V1"
  );
  assert.match(
    communicationsEvidenceMigration,
    /ADD COLUMN "communicationType" TEXT/
  );
  assert.doesNotMatch(
    communicationsEvidenceMigration,
    /\bDROP\s+(?:TABLE|COLUMN|TYPE|INDEX)\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i
  );

  const legacyRetryWorker = readFileSync(
    new URL("../workers/message.retry.worker.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    legacyRetryWorker,
    /yieldsToGuestJourneyCommunicationsOwner/
  );
  assert.match(
    legacyRetryWorker,
    /retry yielded to Guest Journey COMMUNICATIONS owner/
  );
});

test("pins E8 to canonical ACCESS provisioning and revocation only", () => {
  assert.equal(
    GUEST_JOURNEY_ACCESS_OWNER_VERSION,
    "guest_journey_access_owner_v1"
  );
  assert.equal(
    GUEST_JOURNEY_ACCESS_PROVISIONING_HANDLER_CODE,
    "ACCESS_PROVISIONING_V1"
  );
  assert.equal(
    GUEST_JOURNEY_ACCESS_REVOCATION_HANDLER_CODE,
    "ACCESS_REVOCATION_CHECK_V1"
  );

  const adapter = readFileSync(
    new URL(
      "./guest-journey-access-owner-adapter.service.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(adapter, /activateGrant/);
  assert.match(adapter, /deactivateGrant/);
  assert.match(adapter, /claimAccessRecoveryAttempt/);
  assert.match(adapter, /recordAccessRecoveryFailure/);
  assert.match(adapter, /recordAccessRecoverySuccess/);
  assert.doesNotMatch(
    adapter,
    /ttlock(?:Get|Create|Delete|Change|Fetch|List)[A-Za-z]+\s*\(/
  );

  const worker = readFileSync(
    new URL("../workers/reservation.worker.ts", import.meta.url),
    "utf8"
  );
  assert.match(worker, /resolveGuestJourneyAccessOwnerConfig/);
  assert.match(worker, /runGuestJourneyAccessOwnerCycle/);
  assert.match(worker, /isGuestJourneyAccessOwnerScope/);
  assert.match(
    worker,
    /legacy guest access provisioning yielded to Guest Journey ACCESS owner/
  );
  assert.match(
    worker,
    /legacy guest access revocation yielded to Guest Journey ACCESS owner/
  );

  const accessGrantExpireWorker = readFileSync(
    new URL("../workers/access-grant-expire.worker.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    accessGrantExpireWorker,
    /resolveGuestJourneyAccessOwnerConfig/
  );
  assert.match(
    accessGrantExpireWorker,
    /isGuestJourneyAccessOwnerScope/
  );
  assert.match(
    accessGrantExpireWorker,
    /type:\s*true/
  );
  assert.match(
    accessGrantExpireWorker,
    /legacy guest access yielded to E8/
  );

  const passcodeExpireWorker = readFileSync(
    new URL("../workers/passcode-expire.worker.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    passcodeExpireWorker,
    /resolveGuestJourneyAccessOwnerConfig/
  );
  assert.match(
    passcodeExpireWorker,
    /isGuestJourneyAccessOwnerScope/
  );
  assert.match(
    passcodeExpireWorker,
    /yieldedToE8/
  );

  const accessNfcRoutes = readFileSync(
    new URL("../routes/access.nfc.routes.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    accessNfcRoutes,
    /resolveGuestJourneyAccessOwnerConfig/
  );
  assert.match(
    accessNfcRoutes,
    /GUEST_NFC_OWNED_BY_GUEST_JOURNEY_ACCESS_OWNER/
  );
});

test("pins E9 to read-only FINANCIAL payment evaluation only", () => {
  assert.equal(
    GUEST_JOURNEY_FINANCIAL_OWNER_VERSION,
    "guest_journey_financial_owner_v1"
  );
  assert.equal(
    GUEST_JOURNEY_PAYMENT_EVALUATION_HANDLER_CODE,
    "PAYMENT_EVALUATION_V1"
  );

  const runtime = readFileSync(
    new URL(
      "./guest-journey-financial-owner-runtime.service.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(runtime, /targetEngine:\s*"FINANCIAL"/);
  assert.match(runtime, /REQUEST_PAYMENT_EVALUATION/);
  assert.match(runtime, /PAYMENT_STATE_RESOLVED/);
  assert.doesNotMatch(runtime, /REQUEST_ACCESS_|REQUEST_COMMUNICATION|REQUEST_GUEST_VERIFICATION|REQUEST_REQUIREMENTS_SNAPSHOT/);

  const adapter = readFileSync(
    new URL(
      "./guest-journey-financial-evaluation-adapter.service.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(
    adapter,
    /from\s+["'][^"']*(stripe|ttlock|messaging|mailer|access|nfc)[^"']*["']/
  );
  assert.doesNotMatch(
    adapter,
    /\b(createCheckout|createPayment|charge|refund|transfer|activateGrant|deactivateGrant|sendSms|sendEmail|sendGuest|ttlock)[A-Za-z]*\s*\(/
  );
  assert.match(adapter, /providerCalls:\s*0/);

  const worker = readFileSync(
    new URL("../workers/reservation.worker.ts", import.meta.url),
    "utf8"
  );
  assert.match(worker, /resolveGuestJourneyFinancialOwnerConfig/);
  assert.match(worker, /runGuestJourneyFinancialOwnerCycle/);
  assert.match(
    worker,
    /GUEST_JOURNEY_FINANCIAL_OWNER_CONFIG\.enabled/
  );
});

test("keeps E1 migrations additive and canonical", () => {
  const combined = lifecycleMigration + "\n" + intentMigration;

  assert.doesNotMatch(
    combined,
    /\bDROP\s+(?:TABLE|COLUMN|TYPE|INDEX)\b/i
  );
  assert.doesNotMatch(combined, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(
    combined,
    /\bUPDATE\s+"?[A-Za-z0-9_]+"?\s+SET\b/i
  );
  assert.doesNotMatch(combined, /\bTRUNCATE\b/i);

  for (const engineId of GUEST_JOURNEY_TARGET_ENGINES) {
    assert.match(
      intentMigration,
      new RegExp("'" + engineId + "'")
    );
  }

  for (const intentType of GUEST_JOURNEY_COORDINATION_INTENT_TYPES) {
    assert.match(
      intentMigration,
      new RegExp("'" + intentType + "'")
    );
  }
});

test("keeps E2 shadow through E7 Communications independently default-off", () => {
  const reservationWorker = readFileSync(
    new URL(
      "../workers/reservation.worker.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    reservationWorker,
    /resolveGuestJourneyShadowConfig/
  );
  assert.match(
    reservationWorker,
    /GUEST_JOURNEY_SHADOW_CONFIG\.enabled/
  );
  assert.match(
    reservationWorker,
    /resolveGuestJourneyInternalReconcileConfig/
  );
  assert.match(
    reservationWorker,
    /runGuestJourneyEngineCycle/
  );
  assert.match(
    reservationWorker,
    /GUEST_JOURNEY_INTERNAL_RECONCILE_CONFIG\s*\.enabled/
  );
  assert.doesNotMatch(
    reservationWorker,
    /materializeGuestJourneyCoordinationIntents\s*\(/
  );
  assert.match(
    reservationWorker,
    /resolveGuestJourneyCoordinationConfig/
  );
  assert.match(
    reservationWorker,
    /runGuestJourneyCoordinationCycle/
  );
  assert.match(
    reservationWorker,
    /GUEST_JOURNEY_COORDINATION_CONFIG\s*\.enabled/
  );
  assert.match(
    reservationWorker,
    /resolveGuestJourneyOwnerRuntimeConfig/
  );
  assert.match(
    reservationWorker,
    /runGuestJourneyOwnerRuntimeCycle/
  );
  assert.match(
    reservationWorker,
    /GUEST_JOURNEY_OWNER_RUNTIME_CONFIG\s*\.enabled/
  );
  assert.match(
    reservationWorker,
    /resolveGuestJourneyMissionControlConfig/
  );
  assert.match(
    reservationWorker,
    /runGuestJourneyMissionControlCycle/
  );
  assert.match(
    reservationWorker,
    /GUEST_JOURNEY_MISSION_CONTROL_CONFIG\s*\.enabled/
  );
  assert.match(
    reservationWorker,
    /resolveGuestJourneyCommunicationsOwnerConfig/
  );
  assert.match(
    reservationWorker,
    /runGuestJourneyCommunicationsOwnerCycle/
  );
  assert.match(
    reservationWorker,
    /GUEST_JOURNEY_COMMUNICATIONS_OWNER_CONFIG\s*\.enabled/
  );

  const shadowConfig = readFileSync(
    new URL(
      "./guest-journey-shadow.config.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    shadowConfig,
    /if \(!value\) \{\s*return false;/
  );

  const internalReconcileConfig =
    readFileSync(
      new URL(
        "./guest-journey-internal-reconcile.config.ts",
        import.meta.url
      ),
      "utf8"
    );

  assert.match(
    internalReconcileConfig,
    /if \(!value\) \{\s*return false;/
  );

  const coordinationConfig =
    readFileSync(
      new URL(
        "./guest-journey-coordination.config.ts",
        import.meta.url
      ),
      "utf8"
    );

  assert.match(
    coordinationConfig,
    /if \(!value\) \{\s*return false;/
  );

  const ownerRuntimeConfig =
    readFileSync(
      new URL(
        "./guest-journey-owner-runtime.config.ts",
        import.meta.url
      ),
      "utf8"
    );

  assert.match(
    ownerRuntimeConfig,
    /if \(!value\) return false;/
  );

  const missionControlConfig =
    readFileSync(
      new URL(
        "./guest-journey-mission-control.config.ts",
        import.meta.url
      ),
      "utf8"
    );

  assert.match(
    missionControlConfig,
    /if \(!value\) return false;/
  );

  const communicationsConfig = readFileSync(
    new URL(
      "./guest-journey-communications-owner.config.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    communicationsConfig,
    /if \(!value\) return false;/
  );
});

test("keeps E6 free of credential, provider, messaging and payment execution", () => {
  const bridge = readFileSync(
    new URL(
      "./guest-journey-mission-control-bridge.service.ts",
      import.meta.url
    ),
    "utf8"
  );
  const cycle = readFileSync(
    new URL(
      "./guest-journey-mission-control-cycle.service.ts",
      import.meta.url
    ),
    "utf8"
  );
  const combined = bridge + "\n" + cycle;

  for (const forbiddenImport of [
    "ttlock",
    "mailer",
    "messaging.service",
    "email-delivery",
    "twilio",
    "stripe",
    "activateGrant",
    "deactivateGrant",
    "sendGuest",
  ]) {
    assert.doesNotMatch(
      combined,
      new RegExp(
        `(?:from|import\\()[^\\n]*${forbiddenImport}`,
        "i"
      )
    );
  }

  assert.doesNotMatch(
    combined,
    /ownerEngineExecutions:\s*[1-9]/
  );
  assert.doesNotMatch(
    combined,
    /credentialWrites:\s*[1-9]/
  );
  assert.doesNotMatch(
    combined,
    /messageSends:\s*[1-9]/
  );
  assert.doesNotMatch(
    combined,
    /paymentCalls:\s*[1-9]/
  );
});

test("keeps the E5 ACCESS handler free of credential, messaging and payment execution", () => {
  const handler = readFileSync(
    new URL(
      "./guest-journey-access-evaluation-handler.service.ts",
      import.meta.url
    ),
    "utf8"
  );

  for (const forbiddenImport of [
    "ttlock",
    "mailer",
    "messaging.service",
    "email-delivery",
    "twilio",
    "stripe",
    "activateGrant",
    "sendGuest",
  ]) {
    assert.doesNotMatch(
      handler,
      new RegExp(forbiddenImport, "i")
    );
  }
});
