import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import type { PinAIRuntimeRequest } from "./contracts.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { GuardedPinAIModelAdapter } from "./model-adapter.js";
import { OpenAIAgentsRuntimeTransport } from "./openai-agents-runtime-transport.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";
import { createPinGoRuntimeReadToolExecutor } from "./pin-go-runtime-tools.js";

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

  const reservations = await prisma.reservation.findMany({
    where: {
      status: "ACTIVE",
      totalAmount: { gt: 0 },
      cancellationPolicySnapshot: { not: Prisma.DbNull },
      property: { status: "ACTIVE" },
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: {
      id: true,
      propertyId: true,
      preferredLanguage: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });
  if (reservations.length === 0) {
    throw new Error(
      "PIN_AI_RUNTIME_STAGING_CANCELLATION_POLICY_RESERVATION_NOT_FOUND",
    );
  }

  const candidate = await findValidCandidate(reservations);
  if (!candidate) {
    throw new Error("PIN_AI_RUNTIME_CANCELLATION_POLICY_NO_VALID_SNAPSHOT");
  }

  const request: PinAIRuntimeRequest = {
    context: candidate.context,
    conversation: [
      {
        role: "guest",
        content:
          candidate.context.preferredLanguage === "es"
            ? "Solo quiero información por ahora: ¿qué ocurriría si cancelo mi reservación hoy?"
            : "I only want information for now: what would happen if I cancel my reservation today?",
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
      throw new Error("PIN_AI_RUNTIME_CANCELLATION_POLICY_NETWORK_CALL_LIMIT");
    }
    const response = await fetch(input, init);
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json(),
    };
  };

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

  console.log("PIN_AI_RUNTIME_CANCELLATION_POLICY_LUNA_STARTED:gpt-5.6-luna");
  const response = await model.run(
    request,
    createConversationMemory(request),
    createPinGoRuntimeReadToolExecutor(),
  );

  if (
    !response.toolCalls.some(
      (call) => call.name === "get_cancellation_policy",
    )
  ) {
    throw new Error("PIN_AI_RUNTIME_CANCELLATION_POLICY_TOOL_NOT_CALLED");
  }
  if (response.escalationCreated !== false) {
    throw new Error(
      "PIN_AI_RUNTIME_CANCELLATION_POLICY_ESCALATION_EXECUTED",
    );
  }
  if (response.requiresHumanReview !== candidate.requiresHumanReview) {
    throw new Error(
      "PIN_AI_RUNTIME_CANCELLATION_POLICY_REVIEW_METADATA_INVALID",
    );
  }

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_REAL_CANCELLATION_POLICY_LUNA",
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
      authorizationGranted: false,
      cancellationExecuted: false,
      refundExecuted: false,
      chargeExecuted: false,
      actionsExecuted: false,
      databaseWrites: false,
      outboundCalls,
    }),
  );

  await prisma.$disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function findValidCandidate(
  reservations: readonly any[],
): Promise<Readonly<{
  context: PinAIRuntimeRequest["context"];
  requiresHumanReview: boolean;
}> | null> {
  const executor = new PinGoRuntimeReadToolExecutor(prisma);

  for (const reservation of reservations) {
    const context: PinAIRuntimeRequest["context"] = {
      organizationId: reservation.property.organizationId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      guestId: "runtime-shadow-cancellation-policy-preflight-guest",
      currentLocalDateTime: new Date().toISOString(),
      preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
    };
    const request: PinAIRuntimeRequest = {
      context,
      conversation: [{ role: "guest", content: "Policy preflight." }],
    };
    const result = await executor.execute(
      "get_cancellation_policy",
      {},
      request,
      createConversationMemory(request),
    );
    if (result.decision === "CANCELLATION_POLICY_EVALUATED") {
      return {
        context,
        requiresHumanReview: result.requiresHumanReview === true,
      };
    }
  }

  return null;
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_CANCELLATION_POLICY_LUNA_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
