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
  "get_guest_journey_status",
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

test("action proposal tool stays absent from the default saved-agent manifest", () => {
  const tools = buildPinAIOpenAITools();
  assert.equal(
    tools.some(
      (tool) =>
        tool.type === "function" &&
        tool.name === "prepare_reservation_modification"
    ),
    false,
  );
});

test("action proposal tool and guest-confirmation instructions appear only behind the explicit gate", () => {
  const config = buildPinAIOpenAIAgentConfig(
    undefined,
    { enabled: true },
  );
  const tools = Array.isArray(config.tools)
    ? config.tools as Array<Record<string, unknown>>
    : [];
  const instructions = String(config.instructions ?? "");

  assert.equal(
    tools.some(
      (tool) =>
        tool.type === "function" &&
        tool.name === "prepare_reservation_modification"
    ),
    true,
  );
  assert.match(instructions, /exact quote expiration/i);
  assert.match(instructions, /availability is not held/i);
  assert.match(instructions, /confirmation control/i);
  assert.match(instructions, /Never ask the guest to type or repeat a confirmation token/i);
  assert.match(instructions, /actionExecuted=true/i);
});


test("canary proposal schema allows checkout-only extensions and instructs preservation of check-in", () => {
  const config = buildPinAIOpenAIAgentConfig(undefined, { enabled: true });
  const tools = config.tools as Array<Record<string, unknown>>;
  const tool = tools.find((item) => item.name === "prepare_reservation_modification")!;
  const parameters = tool.parameters as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(parameters.required, ["proposedCheckOutDate"]);
  assert.deepEqual(parameters.properties.operation.enum, ["EXTEND_CHECKOUT_ONLY"]);
  assert.match(String(config.instructions), /Omit proposedCheckInDate: the server preserves the stored check-in/);
  assert.match(String(config.instructions), /Pre-stay date changes still require both exact dates/);
});


test("guest clock instructions distinguish 12-hour conversation from internal tool time", () => {
  for (const options of [undefined, { enabled: true, stayTimeEnabled: true, dateChangesEnabled: false }]) {
    const config = buildPinAIOpenAIAgentConfig(undefined, options);
    const instructions = String(config.instructions);
    assert.match(instructions, /12-hour format/);
    assert.match(instructions, /Do not ask the guest to use 24-hour format/);
    assert.match(instructions, /1:00 p\.m\. becomes 13:00/);
    assert.match(instructions, /12:00 a\.m\. becomes 00:00/);
    assert.match(instructions, /12:00 p\.m\. becomes 12:00/);
    assert.match(instructions, /ask the guest to clarify rather than guessing/);
    assert.match(instructions, /Keep dates and the property timezone unchanged/);
    const tools = config.tools as Array<{ name: string; parameters: { properties: { requestedLocalTime?: { description: string } } } }>;
    for (const tool of tools.filter(t => ["check_early_checkin", "check_late_checkout", "prepare_reservation_modification"].includes(t.name))) {
      const description = tool.parameters.properties.requestedLocalTime!.description;
      assert.match(description, /Internal zero-padded 24-hour HH:MM/);
      assert.match(description, /never require the guest to use this format/);
    }
  }
});
