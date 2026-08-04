import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_ENGINE_DISPLAY_NAMES,
  CANONICAL_ENGINE_IDS,
  getCanonicalEngineDisplayName,
  isCanonicalEngineId,
  normalizeCanonicalEngineId,
  requireCanonicalEngineId,
} from "./engine-catalog.js";

const EXPECTED_ENGINE_IDS = [
  "GUEST_JOURNEY",
  "COMMUNICATIONS",
  "ACCESS",
  "REVENUE",
  "DISTRIBUTION",
  "OPERATIONS",
  "COMPLIANCE",
  "FINANCIAL",
  "MISSION_CONTROL",
] as const;

test("exposes the complete canonical APMS Engine catalog", () => {
  assert.deepEqual(
    CANONICAL_ENGINE_IDS,
    EXPECTED_ENGINE_IDS
  );

  assert.equal(
    new Set(CANONICAL_ENGINE_IDS).size,
    CANONICAL_ENGINE_IDS.length
  );
});

test("accepts every canonical Engine identifier", () => {
  for (const engineId of EXPECTED_ENGINE_IDS) {
    assert.equal(
      isCanonicalEngineId(engineId),
      true
    );
    assert.equal(
      normalizeCanonicalEngineId(engineId),
      engineId
    );
    assert.equal(
      requireCanonicalEngineId(engineId),
      engineId
    );
  }
});

test("rejects noncanonical identifiers at the strict type guard", () => {
  const rejectedValues = [
    "Guest Journey",
    "Messaging",
    "Cleaning",
    "Device Health",
    "Reservation",
    "",
    null,
    undefined,
  ];

  for (const value of rejectedValues) {
    assert.equal(
      isCanonicalEngineId(value),
      false
    );
  }
});

test("normalizes approved legacy Engine identifiers deterministically", () => {
  const cases: ReadonlyArray<
    readonly [unknown, (typeof EXPECTED_ENGINE_IDS)[number]]
  > = [
    ["Guest Journey", "GUEST_JOURNEY"],
    ["guest-journey", "GUEST_JOURNEY"],
    ["Messaging", "COMMUNICATIONS"],
    ["communications", "COMMUNICATIONS"],
    ["Access", "ACCESS"],
    ["ACCESS", "ACCESS"],
    ["Device Health", "ACCESS"],
    ["Revenue", "REVENUE"],
    ["Distribution", "DISTRIBUTION"],
    ["Distribution / PMS", "DISTRIBUTION"],
    ["PMS", "DISTRIBUTION"],
    ["Cleaning", "OPERATIONS"],
    ["Operations", "OPERATIONS"],
    ["Identity", "COMPLIANCE"],
    ["Compliance", "COMPLIANCE"],
    ["Payments", "FINANCIAL"],
    ["Payouts", "FINANCIAL"],
    ["MissionControl", "MISSION_CONTROL"],
    ["Mission Control", "MISSION_CONTROL"],
  ];

  for (const [value, expected] of cases) {
    assert.equal(
      normalizeCanonicalEngineId(value),
      expected,
      `Expected ${String(value)} to normalize to ${expected}`
    );
  }
});

test("does not recognize Reservation as an APMS Engine", () => {
  assert.equal(
    normalizeCanonicalEngineId("Reservation"),
    null
  );

  assert.throws(
    () => requireCanonicalEngineId("Reservation"),
    /Unknown APMS Engine identifier: Reservation/
  );
});

test("rejects empty and unknown identifiers explicitly", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(
      normalizeCanonicalEngineId(value),
      null
    );
    assert.throws(
      () => requireCanonicalEngineId(value),
      /APMS Engine identifier is required\./
    );
  }

  for (const value of [
    "DEVICE_HEALTH_ENGINE",
    "CLEANING_ENGINE",
    "UNKNOWN_ENGINE",
  ]) {
    assert.equal(
      normalizeCanonicalEngineId(value),
      null
    );
    assert.throws(
      () => requireCanonicalEngineId(value),
      new RegExp(
        `Unknown APMS Engine identifier: ${value}`
      )
    );
  }
});

test("provides a display name for every canonical Engine", () => {
  assert.deepEqual(
    Object.keys(CANONICAL_ENGINE_DISPLAY_NAMES),
    EXPECTED_ENGINE_IDS
  );

  for (const engineId of EXPECTED_ENGINE_IDS) {
    const displayName =
      getCanonicalEngineDisplayName(engineId);

    assert.equal(
      displayName,
      CANONICAL_ENGINE_DISPLAY_NAMES[engineId]
    );
    assert.ok(displayName.length > 0);
  }
});
