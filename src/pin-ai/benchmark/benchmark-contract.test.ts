import assert from "node:assert/strict";
import test from "node:test";

import { MOCK_TOOL_NAMES, type BenchmarkScenario } from "./contracts.js";
import { scenarios001To010 } from "./scenarios-001-010.js";
import { scenarios011To020 } from "./scenarios-011-020.js";
import { scenarios021To030 } from "./scenarios-021-030.js";
import { scenarios031To040 } from "./scenarios-031-040.js";
import { scenarios041To050 } from "./scenarios-041-050.js";
import { scenarios051To060 } from "./scenarios-051-060.js";
import { scenarios061To070 } from "./scenarios-061-070.js";

const scenarios: readonly BenchmarkScenario[] = [
  ...scenarios001To010,
  ...scenarios011To020,
  ...scenarios021To030,
  ...scenarios031To040,
  ...scenarios041To050,
  ...scenarios051To060,
  ...scenarios061To070,
];

test("Pin AI benchmark scenarios 001-070 satisfy the isolated contract", () => {
  assert.equal(scenarios.length, 70);

  const ids = scenarios.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, Array.from({ length: 70 }, (_, index) => String(index + 1).padStart(3, "0")));

  for (const scenario of scenarios) {
    assert.match(scenario.context.organizationId, /^benchmark-/);
    assert.match(scenario.context.propertyId, /^benchmark-/);
    assert.match(scenario.context.reservationId, /^benchmark-/);
    assert.match(scenario.context.guestId, /^benchmark-/);
    assert.ok(scenario.conversation.length > 0);
    assert.ok(scenario.expectation.intents.length > 0);
    assert.ok(scenario.expectation.requiredBehaviors.length > 0);

    for (const tool of scenario.expectation.requiredTools ?? []) {
      assert.ok(MOCK_TOOL_NAMES.includes(tool), `unknown required mock tool: ${tool}`);
    }

    for (const tool of scenario.expectation.forbiddenTools ?? []) {
      assert.ok(MOCK_TOOL_NAMES.includes(tool), `unknown forbidden mock tool: ${tool}`);
    }
  }
});

test("security scenarios define explicit forbidden behavior or critical failure conditions", () => {
  const securityScenarios = scenarios.filter((scenario) => scenario.category === "SECURITY");
  assert.ok(securityScenarios.length > 0);

  for (const scenario of securityScenarios) {
    const hasForbiddenBehavior = scenario.expectation.forbiddenBehaviors.length > 0;
    const hasCriticalFailure = (scenario.expectation.criticalFailureConditions?.length ?? 0) > 0;
    assert.ok(hasForbiddenBehavior || hasCriticalFailure, `security scenario ${scenario.id} lacks a safety assertion`);
  }
});
