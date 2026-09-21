import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import {
  isPinAIRuntimeToolEnabled,
  type PinAIRuntimeRequest,
} from "./contracts.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";

const TOOL_NAME = "get_payment_context" as const;

async function main(): Promise<void> {
  if (process.env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (process.env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }
  if (isPinAIRuntimeToolEnabled(TOOL_NAME)) {
    throw new Error("PIN_AI_RUNTIME_PAYMENT_CONTEXT_TOOL_MUST_REMAIN_HIDDEN");
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

  const executor = new PinGoRuntimeReadToolExecutor(prisma);
  console.log("PIN_AI_RUNTIME_PAYMENT_CONTEXT_STARTED:DIRECT_READ_ONLY");

  for (const reservation of reservations) {
    const request: PinAIRuntimeRequest = {
      context: {
        organizationId: reservation.property.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        guestId: "runtime-shadow-payment-context-staging-guest",
        currentLocalDateTime: new Date().toISOString(),
        preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
      },
      conversation: [
        {
          role: "guest",
          content:
            reservation.preferredLanguage === "es"
              ? "¿Cuál es el estado de pago registrado para mi reservación?"
              : "What payment status is recorded for my reservation?",
        },
      ],
    };

    const result = await executor.execute(
      TOOL_NAME,
      {},
      request,
      createConversationMemory(request),
    );

    if (result.decision !== "PAYMENT_CONTEXT_READ") {
      console.log(
        JSON.stringify({
          runtime: "pin-ai-v1",
          mode: "SHADOW_REAL_PAYMENT_CONTEXT_CANDIDATE_SKIPPED",
          reservationId: reservation.id,
          decision: result.decision,
        }),
      );
      continue;
    }

    assertReadOnlyPaymentResult(result);
    console.log(
      JSON.stringify({
        runtime: "pin-ai-v1",
        mode: "SHADOW_REAL_PAYMENT_CONTEXT",
        model: null,
        scope: {
          organizationId: request.context.organizationId,
          propertyId: request.context.propertyId,
          reservationId: request.context.reservationId,
        },
        toolCalls: [{ name: TOOL_NAME, arguments: {} }],
        result,
        authorizationGranted: false,
        paymentAuthorized: false,
        chargeExecuted: false,
        refundExecuted: false,
        transferExecuted: false,
        actionsExecuted: false,
        databaseWrites: false,
        openAICalls: 0,
      }),
    );

    await prisma.$disconnect();
    return;
  }

  throw new Error("PIN_AI_RUNTIME_PAYMENT_CONTEXT_NO_VALID_RESERVATION");
}

function assertReadOnlyPaymentResult(
  result: Readonly<Record<string, unknown>>,
): void {
  if (
    result.authorizationGranted !== false ||
    result.paymentAuthorized !== false ||
    result.chargeExecuted !== false ||
    result.refundExecuted !== false ||
    result.transferExecuted !== false ||
    !result.payment ||
    !result.financialAuthority
  ) {
    throw new Error("PIN_AI_RUNTIME_PAYMENT_CONTEXT_READ_ONLY_INVARIANT_FAILED");
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_PAYMENT_CONTEXT_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
