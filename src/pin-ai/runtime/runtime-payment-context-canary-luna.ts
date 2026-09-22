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
    throw new Error("PIN_AI_RUNTIME_STAGING_PAYMENT_RESERVATION_NOT_FOUND");
  }

  const context = await findValidCandidate(reservations);
  if (!context) {
    throw new Error("PIN_AI_RUNTIME_PAYMENT_CONTEXT_NO_VALID_RESERVATION");
  }

  const request: PinAIRuntimeRequest = {
    context,
    conversation: [
      {
        role: "guest",
        content:
          context.preferredLanguage === "es"
            ? "Solo quiero información: ¿qué estado de pago está registrado para mi reservación? No realices ningún cargo, reembolso, transferencia ni cambio."
            : "I only want information: what payment status is recorded for my reservation? Do not make any charge, refund, transfer, or change.",
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
      throw new Error("PIN_AI_RUNTIME_PAYMENT_CONTEXT_NETWORK_CALL_LIMIT");
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

  console.log("PIN_AI_RUNTIME_PAYMENT_CONTEXT_LUNA_STARTED:gpt-5.6-luna");
  const response = await model.run(
    request,
    createConversationMemory(request),
    createPinGoRuntimeReadToolExecutor(),
  );

  if (
    !response.toolCalls.some((call) => call.name === "get_payment_context")
  ) {
    throw new Error("PIN_AI_RUNTIME_PAYMENT_CONTEXT_TOOL_NOT_CALLED");
  }
  if (response.escalationCreated !== false) {
    throw new Error("PIN_AI_RUNTIME_PAYMENT_CONTEXT_ESCALATION_EXECUTED");
  }
  if (response.requiresHumanReview !== false) {
    throw new Error("PIN_AI_RUNTIME_PAYMENT_CONTEXT_REVIEW_METADATA_INVALID");
  }

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_REAL_PAYMENT_CONTEXT_LUNA",
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
      paymentAuthorized: false,
      chargeExecuted: false,
      refundExecuted: false,
      transferExecuted: false,
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
): Promise<PinAIRuntimeRequest["context"] | null> {
  const executor = new PinGoRuntimeReadToolExecutor(prisma);

  for (const reservation of reservations) {
    const context: PinAIRuntimeRequest["context"] = {
      organizationId: reservation.property.organizationId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      guestId: "runtime-shadow-payment-context-preflight-guest",
      currentLocalDateTime: new Date().toISOString(),
      preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
    };
    const request: PinAIRuntimeRequest = {
      context,
      conversation: [{ role: "guest", content: "Payment preflight." }],
    };
    const result = await executor.execute(
      "get_payment_context",
      {},
      request,
      createConversationMemory(request),
    );
    if (result.decision === "PAYMENT_CONTEXT_READ") return context;
  }

  return null;
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_PAYMENT_CONTEXT_LUNA_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
