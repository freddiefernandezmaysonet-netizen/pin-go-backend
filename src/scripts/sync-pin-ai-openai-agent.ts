import {
  auditOpenAISavedAgent,
  planOpenAISavedAgentSync,
} from "../pin-ai/runtime/openai-saved-agent-audit.js";

const apiKey = process.env.OPENAI_API_KEY;
const agentId = process.env.PIN_AI_OPENAI_AGENT_ID;
const apply = process.env.PIN_AI_OPENAI_AGENT_SYNC_APPLY === "true";

if (!apiKey) {
  throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
}
if (!agentId || !/^agent_[A-Za-z0-9]+$/.test(agentId)) {
  throw new Error("PIN_AI_RUNTIME_OPENAI_AGENT_ID_MISSING_OR_INVALID");
}

const current = await requestAgent("GET");
const plan = planOpenAISavedAgentSync(agentId, current);

console.log(
  JSON.stringify(
    {
      mode: apply ? "APPLY" : "DRY_RUN",
      before: plan.before,
      expectedAfter: plan.expectedAfter,
    },
    null,
    2,
  ),
);

if (!apply) {
  console.log("DRY_RUN_COMPLETE: set PIN_AI_OPENAI_AGENT_SYNC_APPLY=true to apply");
} else {
  await requestAgent("POST", plan.update);
  const verified = auditOpenAISavedAgent(agentId, await requestAgent("GET"));
  console.log(JSON.stringify({ verified }, null, 2));
  if (!verified.ready) {
    throw new Error("PIN_AI_OPENAI_AGENT_SYNC_VERIFICATION_FAILED");
  }
}

async function requestAgent(
  method: "GET" | "POST",
  body?: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await fetch(
    `https://api.openai.com/v1/agents/${encodeURIComponent(agentId!)}`,
    {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "OpenAI-Beta": "agents=v1",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(`PIN_AI_OPENAI_AGENT_SYNC_HTTP_${response.status}`);
  }
  return response.json();
}
