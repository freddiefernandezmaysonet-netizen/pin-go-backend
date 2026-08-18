import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GuestJourneyState } from "@prisma/client";

import {
  CANONICAL_GUEST_JOURNEY_STATE_ORDER,
  GUEST_JOURNEY_COORDINATION_INTENT_TYPES,
  GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
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

test("keeps E2 shadow default-off and excludes state reconciliation or owner execution", () => {
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
  assert.doesNotMatch(
    reservationWorker,
    /guest-journey-(?:reconciler|coordination-intent|compliance-intent)/
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
});
