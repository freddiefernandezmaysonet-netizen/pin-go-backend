import { createConversationMemory } from "./conversation-memory.js";
import { GuardedPinAIModelAdapter } from "./model-adapter.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { OpenAIAgentsRuntimeTransport } from "./openai-agents-runtime-transport.js";
import {
  GuardedPinAIRuntimeToolExecutor,
  type PinAIRuntimeToolExecutor,
} from "./tool-executor.js";
import type { PinAIRuntimeRequest } from "./contracts.js";

async function main(): Promise<void> {
  if (process.env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
  }

  const request: PinAIRuntimeRequest = {
    context: {
      organizationId: "runtime-shadow-org-a",
      propertyId: "runtime-shadow-property-a",
      reservationId: "runtime-shadow-reservation-a",
      guestId: "runtime-shadow-guest-a",
      currentLocalDateTime: "2026-09-20T09:30:00-04:00",
      preferredLanguage: "en",
    },
    conversation: [
      {
        role: "assistant",
        content:
          "We already completed the approved thermostat reset, but the AC is still not cooling.",
      },
      {
        role: "guest",
        content:
          "It still isn't cooling and my baby can't sleep. What can you do?",
      },
    ],
  };

  let outboundCalls = 0;
  const guardedFetch = async (
    input: string,
    init: Readonly<{
      method: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ) => {
    outboundCalls += 1;
    if (outboundCalls > 40) {
      throw new Error("PIN_AI_RUNTIME_SHADOW_NETWORK_CALL_LIMIT");
    }

    const response = await fetch(input, init);
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json(),
    };
  };

  const syntheticTools: PinAIRuntimeToolExecutor = {
    async execute(tool) {
      if (tool === "get_property_knowledge") {
        return {
          propertyFacts: {
            airConditioning:
              "The approved thermostat reset has already been exhausted. If the unit still does not cool, escalate for maintenance. Do not repeat the reset.",
          },
        };
      }

      if (tool === "get_reservation_context") {
        return {
          reservationStatus: "ACTIVE",
          checkOutLocal: "2026-09-22T11:00:00-04:00",
        };
      }

      if (tool === "get_access_status") {
        return {
          accessStatus: "ACTIVE",
        };
      }

      throw new Error(`PIN_AI_RUNTIME_SHADOW_TOOL_FIXTURE_MISSING:${tool}`);
    },
  };

  const tools = new GuardedPinAIRuntimeToolExecutor(syntheticTools);
  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: true,
      apiKey,
      model: "gpt-5.6-luna",
      maxPolls: 30,
      pollDelayMs: 500,
    },
    guardedFetch,
  );
  const model = new GuardedPinAIModelAdapter(
    new LunaRuntimeAdapter(transport),
  );

  console.log("PIN_AI_RUNTIME_SHADOW_STARTED:gpt-5.6-luna");

  const memory = createConversationMemory(request);
  const response = await model.run(request, memory, tools);

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW",
      model: "gpt-5.6-luna",
      responseText: response.responseText,
      toolCalls: response.toolCalls.map((call) => call.name),
      escalationCreated: response.escalationCreated,
      requiresHumanReview: response.requiresHumanReview,
      actionsExecuted: false,
      attemptedTroubleshooting: memory.attemptedTroubleshooting,
      outboundCalls,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 1000));
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_SHADOW_FAILED:${message}`);
  process.exitCode = 1;
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
