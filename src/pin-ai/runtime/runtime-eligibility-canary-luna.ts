import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import { GuardedPinAIModelAdapter } from "./model-adapter.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { OpenAIAgentsRuntimeTransport } from "./openai-agents-runtime-transport.js";
import { createPinGoRuntimeReadToolExecutor } from "./pin-go-runtime-tools.js";
import type { PinAIRuntimeRequest } from "./contracts.js";

async function main(): Promise<void> {
  if (process.env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (process.env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      status: "ACTIVE",
      property: { status: "ACTIVE" },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      propertyId: true,
      preferredLanguage: true,
      property: {
        select: {
          organizationId: true,
          timezone: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error("PIN_AI_RUNTIME_STAGING_ACTIVE_RESERVATION_NOT_FOUND");
  }

  const request: PinAIRuntimeRequest = {
    context: {
      organizationId: reservation.property.organizationId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      guestId: "runtime-shadow-staging-guest",
      currentLocalDateTime: new Date().toISOString(),
      preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
    },
    conversation: [
      {
        role: "guest",
        content:
          reservation.preferredLanguage === "es"
            ? "¿Puedo hacer checkout a la 1:00 PM y también quedarme una noche adicional?"
            : "Can I check out at 1:00 PM and also stay one additional night?",
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
    if (outboundCalls > 50) {
      throw new Error("PIN_AI_RUNTIME_ELIGIBILITY_NETWORK_CALL_LIMIT");
    }

    const response = await fetch(input, init);
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json(),
    };
  };

  const tools = createPinGoRuntimeReadToolExecutor();
  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: true,
      apiKey,
      model: "gpt-5.6-luna",
      maxPolls: 40,
      pollDelayMs: 500,
    },
    guardedFetch,
  );

  const model = new GuardedPinAIModelAdapter(
    new LunaRuntimeAdapter(transport),
  );

  console.log("PIN_AI_RUNTIME_ELIGIBILITY_STARTED:gpt-5.6-luna");

  const memory = createConversationMemory(request);
  const response = await model.run(request, memory, tools);

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_REAL_ELIGIBILITY",
      model: "gpt-5.6-luna",
      scope: {
        organizationId: request.context.organizationId,
        propertyId: request.context.propertyId,
        reservationId: request.context.reservationId,
      },
      responseText: response.responseText,
      toolCalls: response.toolCalls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
      escalationCreated: response.escalationCreated,
      requiresHumanReview: response.requiresHumanReview,
      actionsExecuted: false,
      databaseWrites: false,
      outboundCalls,
    }),
  );

  await prisma.$disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_ELIGIBILITY_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
