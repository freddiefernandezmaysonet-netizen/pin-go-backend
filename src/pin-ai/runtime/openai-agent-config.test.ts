import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPinAIOpenAIAgentConfig,
  buildPinAIOpenAITools,
  PIN_AI_OPENAI_AGENT_INSTRUCTIONS,
  PIN_AI_OPENAI_AGENT_NAME,
} from "./openai-agent-config.js";

const EXPECTED_FUNCTION_TOOLS = [
  "get_property_knowledge",
  "get_reservation_context",
  "get_access_status",
  "get_cleaning_status",
  "check_early_checkin",
  "check_late_checkout",
  "check_extension_availability",
  "calculate_extension_price",
  "check_date_change",
  "get_cancellation_policy",
  "get_payment_context",
  "escalate_to_host",
] as const;

test("saved-agent manifest contains exactly the certified Runtime V1 function tools", () => {
  const tools = buildPinAIOpenAITools();
  const functionToolNames = tools
    .filter((tool) => tool.type === "function")
    .map((tool) => tool.name);

  assert.equal(PIN_AI_OPENAI_AGENT_NAME, "Pin AI Guest Services - Shadow");
  assert.deepEqual(functionToolNames, EXPECTED_FUNCTION_TOOLS);
  assert.equal(tools.some((tool) => tool.name === "search_local_places"), false);
  assert.equal(tools.some((tool) => tool.type === "web_search"), false);
});

test("saved-agent manifest adds native web search without exposing a search function", () => {
  const tools = buildPinAIOpenAITools({
    enabled: true,
    mode: "live",
    location: {
      country: "PR",
      region: "Puerto Rico",
      city: "San Juan",
      timezone: "America/Puerto_Rico",
    },
  });

  assert.deepEqual(tools[0], {
    type: "web_search",
    mode: "live",
    location: {
      country: "PR",
      region: "Puerto Rico",
      city: "San Juan",
      timezone: "America/Puerto_Rico",
    },
  });
  assert.equal(
    tools.filter((tool) => tool.type === "function").length,
    EXPECTED_FUNCTION_TOOLS.length,
  );
  assert.equal(tools.some((tool) => tool.name === "search_local_places"), false);
});

test("saved-agent manifest preserves shadow truthfulness instructions", () => {
  const config = buildPinAIOpenAIAgentConfig();

  assert.equal(config.model, "gpt-5.6-luna");
  assert.equal(config.instructions, PIN_AI_OPENAI_AGENT_INSTRUCTIONS);
  assert.match(PIN_AI_OPENAI_AGENT_INSTRUCTIONS, /executed=true/i);
  assert.match(PIN_AI_OPENAI_AGENT_INSTRUCTIONS, /extension pricing as an estimate/i);
  assert.match(PIN_AI_OPENAI_AGENT_INSTRUCTIONS, /date-change availability/i);
  assert.match(PIN_AI_OPENAI_AGENT_INSTRUCTIONS, /cancellation-policy results/i);
  assert.match(PIN_AI_OPENAI_AGENT_INSTRUCTIONS, /payment context as read-only/i);
});
