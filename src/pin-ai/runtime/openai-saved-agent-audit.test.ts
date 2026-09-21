import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPinAIOpenAIAgentConfig,
  PIN_AI_OPENAI_AGENT_INSTRUCTIONS,
  PIN_AI_OPENAI_AGENT_NAME,
} from "./openai-agent-config.js";
import {
  auditOpenAISavedAgent,
  planOpenAISavedAgentSync,
} from "./openai-saved-agent-audit.js";

test("saved-agent audit identifies the five post-baseline tools and native search as missing", () => {
  const originalToolNames = [
    "get_property_knowledge",
    "get_reservation_context",
    "get_access_status",
    "get_cleaning_status",
    "check_early_checkin",
    "check_late_checkout",
    "check_extension_availability",
    "escalate_to_host",
  ];
  const audit = auditOpenAISavedAgent("agent_shadow123", {
    name: PIN_AI_OPENAI_AGENT_NAME,
    model: "gpt-5.6-luna",
    instructions: "Original shadow instructions",
    tools: originalToolNames.map((name) => ({ type: "function", name })),
  });

  assert.deepEqual(audit.missingFunctionTools, [
    "get_guest_journey_status",
    "calculate_extension_price",
    "check_date_change",
    "get_cancellation_policy",
    "get_payment_context",
  ]);
  assert.deepEqual(audit.unexpectedFunctionTools, []);
  assert.equal(audit.webSearchPresent, false);
  assert.equal(audit.instructionsMatch, false);
  assert.equal(audit.ready, false);
});

test("saved-agent audit passes only the canonical Runtime V1 manifest", () => {
  const config = buildPinAIOpenAIAgentConfig({ enabled: true, mode: "live" });
  const audit = auditOpenAISavedAgent("agent_shadow123", {
    name: PIN_AI_OPENAI_AGENT_NAME,
    model: config.model,
    instructions: PIN_AI_OPENAI_AGENT_INSTRUCTIONS,
    tools: config.tools,
  });

  assert.deepEqual(audit.missingFunctionTools, []);
  assert.deepEqual(audit.unexpectedFunctionTools, []);
  assert.equal(audit.webSearchPresent, true);
  assert.equal(audit.nameMatches, true);
  assert.equal(audit.modelMatches, true);
  assert.equal(audit.instructionsMatch, true);
  assert.equal(audit.ready, true);
});

test("saved-agent audit rejects unexpected function tools", () => {
  const config = buildPinAIOpenAIAgentConfig({ enabled: true, mode: "live" });
  const tools = Array.isArray(config.tools) ? [...config.tools] : [];
  tools.push({ type: "function", name: "issue_refund" });

  const audit = auditOpenAISavedAgent("agent_shadow123", {
    name: PIN_AI_OPENAI_AGENT_NAME,
    model: config.model,
    instructions: config.instructions,
    tools,
  });

  assert.deepEqual(audit.unexpectedFunctionTools, ["issue_refund"]);
  assert.equal(audit.ready, false);
});

test("saved-agent sync plan atomically replaces the tool array with the canonical manifest", () => {
  const originalTools = [
    "get_property_knowledge",
    "get_reservation_context",
    "get_access_status",
    "get_cleaning_status",
    "check_early_checkin",
    "check_late_checkout",
    "check_extension_availability",
    "escalate_to_host",
  ].map((name) => ({ type: "function", name }));
  const plan = planOpenAISavedAgentSync("agent_shadow123", {
    name: PIN_AI_OPENAI_AGENT_NAME,
    model: "gpt-5.6-luna",
    instructions: "Original shadow instructions",
    tools: originalTools,
  });

  assert.deepEqual(plan.before.missingFunctionTools, [
    "get_guest_journey_status",
    "calculate_extension_price",
    "check_date_change",
    "get_cancellation_policy",
    "get_payment_context",
  ]);
  assert.equal(plan.before.webSearchPresent, false);
  assert.equal(plan.expectedAfter.ready, true);
  assert.equal(plan.update.model, "gpt-5.6-luna");
  assert.equal(plan.update.instructions, PIN_AI_OPENAI_AGENT_INSTRUCTIONS);
  assert.equal(
    (plan.update.tools as readonly Readonly<Record<string, unknown>>[])[0]?.type,
    "web_search",
  );
});

test("saved-agent sync plan fails closed before replacing an unexpected tool", () => {
  assert.throws(
    () =>
      planOpenAISavedAgentSync("agent_shadow123", {
        name: PIN_AI_OPENAI_AGENT_NAME,
        model: "gpt-5.6-luna",
        instructions: "Original shadow instructions",
        tools: [{ type: "function", name: "issue_refund" }],
      }),
    /PIN_AI_OPENAI_AGENT_UNEXPECTED_FUNCTION_TOOLS/,
  );
});
