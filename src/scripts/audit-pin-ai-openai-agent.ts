import { auditOpenAISavedAgent } from "../pin-ai/runtime/openai-saved-agent-audit.js";

const apiKey = process.env.OPENAI_API_KEY;
const agentId = process.env.PIN_AI_OPENAI_AGENT_ID;

if (!apiKey) {
  throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
}
if (!agentId || !/^agent_[A-Za-z0-9]+$/.test(agentId)) {
  throw new Error("PIN_AI_RUNTIME_OPENAI_AGENT_ID_MISSING_OR_INVALID");
}

const response = await fetch(
  `https://api.openai.com/v1/agents/${encodeURIComponent(agentId)}`,
  {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "agents=v1",
    },
  },
);

if (!response.ok) {
  throw new Error(`PIN_AI_OPENAI_AGENT_AUDIT_HTTP_${response.status}`);
}

const audit = auditOpenAISavedAgent(agentId, await response.json());
console.log(JSON.stringify(audit, null, 2));

if (!audit.ready) {
  process.exitCode = 1;
}
