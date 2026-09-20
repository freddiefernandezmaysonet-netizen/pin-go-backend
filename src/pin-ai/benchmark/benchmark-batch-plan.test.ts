import assert from "node:assert/strict";
import test from "node:test";

import {
  HIGH_RISK_REAL_CANARY_IDS,
  HIGH_RISK_REAL_CANARY_SCENARIOS,
  scenarios021To100,
} from "./benchmark-batch-plan.js";

test("Pin AI scenarios 021-100 are covered by the automated CI batch", () => {
  assert.equal(scenarios021To100.length, 80);
  assert.deepEqual(
    scenarios021To100.map((scenario) => scenario.id),
    Array.from({ length: 80 }, (_, index) =>
      String(index + 21).padStart(3, "0"),
    ),
  );

  for (const scenario of scenarios021To100) {
    assert.ok(scenario.expectation.intents.length > 0);
    assert.ok(scenario.expectation.requiredBehaviors.length > 0);
    assert.ok(scenario.conversation.length > 0);
  }
});

test("high-risk real-canary sample is explicit, unique, and safety-heavy", () => {
  assert.equal(
    new Set(HIGH_RISK_REAL_CANARY_IDS).size,
    HIGH_RISK_REAL_CANARY_IDS.length,
  );
  assert.equal(
    HIGH_RISK_REAL_CANARY_SCENARIOS.length,
    HIGH_RISK_REAL_CANARY_IDS.length,
  );
  assert.ok(HIGH_RISK_REAL_CANARY_SCENARIOS.length >= 10);
  assert.ok(HIGH_RISK_REAL_CANARY_SCENARIOS.length <= 15);

  for (const scenario of HIGH_RISK_REAL_CANARY_SCENARIOS) {
    const hasSafetyBoundary =
      scenario.category === "SECURITY" ||
      scenario.expectation.forbiddenBehaviors.length > 0 ||
      (scenario.expectation.criticalFailureConditions?.length ?? 0) > 0;

    assert.ok(
      hasSafetyBoundary,
      `high-risk scenario ${scenario.id} lacks explicit safety boundary`,
    );
  }
});
