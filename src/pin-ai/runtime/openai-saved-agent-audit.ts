import {
  buildPinAIOpenAIAgentConfig,
  PIN_AI_OPENAI_AGENT_INSTRUCTIONS,
  PIN_AI_OPENAI_AGENT_NAME,
} from "./openai-agent-config.js";

export type OpenAISavedAgentAudit = Readonly<{
  agentId: string;
  name: string;
  model: string;
  expectedFunctionTools: readonly string[];
  actualFunctionTools: readonly string[];
  missingFunctionTools: readonly string[];
  unexpectedFunctionTools: readonly string[];
  webSearchPresent: boolean;
  nameMatches: boolean;
  modelMatches: boolean;
  instructionsMatch: boolean;
  ready: boolean;
}>;

export type OpenAISavedAgentSyncPlan = Readonly<{
  before: OpenAISavedAgentAudit;
  update: Readonly<Record<string, unknown>>;
  expectedAfter: OpenAISavedAgentAudit;
}>;

export function auditOpenAISavedAgent(
  agentId: string,
  payload: unknown,
): OpenAISavedAgentAudit {
  const agent = asRecord(payload);
  const expected = buildPinAIOpenAIAgentConfig({
    enabled: true,
    mode: "live",
  });
  const expectedTools = Array.isArray(expected.tools) ? expected.tools : [];
  const actualTools = Array.isArray(agent.tools) ? agent.tools : [];
  const expectedFunctionTools = functionToolNames(expectedTools);
  const actualFunctionTools = functionToolNames(actualTools);
  const missingFunctionTools = expectedFunctionTools.filter(
    (name) => !actualFunctionTools.includes(name),
  );
  const unexpectedFunctionTools = actualFunctionTools.filter(
    (name) => !expectedFunctionTools.includes(name),
  );
  const webSearchPresent = actualTools.some(
    (tool) => asRecord(tool).type === "web_search",
  );
  const name = typeof agent.name === "string" ? agent.name : "";
  const model = typeof agent.model === "string" ? agent.model : "";
  const nameMatches = name === PIN_AI_OPENAI_AGENT_NAME;
  const modelMatches = model === "gpt-5.6-luna";
  const instructionsMatch = agent.instructions === PIN_AI_OPENAI_AGENT_INSTRUCTIONS;

  return {
    agentId,
    name,
    model,
    expectedFunctionTools,
    actualFunctionTools,
    missingFunctionTools,
    unexpectedFunctionTools,
    webSearchPresent,
    nameMatches,
    modelMatches,
    instructionsMatch,
    ready:
      nameMatches &&
      modelMatches &&
      instructionsMatch &&
      webSearchPresent &&
      missingFunctionTools.length === 0 &&
      unexpectedFunctionTools.length === 0,
  };
}

export function planOpenAISavedAgentSync(
  agentId: string,
  payload: unknown,
): OpenAISavedAgentSyncPlan {
  const agent = asRecord(payload);
  const before = auditOpenAISavedAgent(agentId, agent);
  if (!before.nameMatches) {
    throw new Error("PIN_AI_OPENAI_AGENT_NAME_MISMATCH");
  }
  if (!before.modelMatches) {
    throw new Error("PIN_AI_OPENAI_AGENT_MODEL_MISMATCH");
  }
  if (before.unexpectedFunctionTools.length > 0) {
    throw new Error("PIN_AI_OPENAI_AGENT_UNEXPECTED_FUNCTION_TOOLS");
  }

  const currentTools = Array.isArray(agent.tools) ? agent.tools : [];
  const unsupportedToolTypes = currentTools
    .map((tool) => asRecord(tool).type)
    .filter((type) => type !== "function" && type !== "web_search");
  if (unsupportedToolTypes.length > 0) {
    throw new Error("PIN_AI_OPENAI_AGENT_UNSUPPORTED_TOOL_TYPES");
  }

  const canonical = buildPinAIOpenAIAgentConfig({
    enabled: true,
    mode: "live",
  });
  const update = {
    model: canonical.model,
    instructions: canonical.instructions,
    tools: canonical.tools,
  };
  const expectedAfter = auditOpenAISavedAgent(agentId, {
    ...agent,
    ...update,
  });
  if (!expectedAfter.ready) {
    throw new Error("PIN_AI_OPENAI_AGENT_SYNC_PLAN_INVALID");
  }

  return { before, update, expectedAfter };
}

function functionToolNames(tools: readonly unknown[]): string[] {
  return tools.flatMap((tool) => {
    const definition = asRecord(tool);
    return definition.type === "function" && typeof definition.name === "string"
      ? [definition.name]
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
