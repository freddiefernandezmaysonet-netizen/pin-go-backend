import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import {
  isPinAIRuntimeToolEnabled,
  type PinAIRuntimeRequest,
} from "./contracts.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";

const TOOL_NAME = "calculate_extension_price" as const;
const ADDITIONAL_NIGHTS = 1;

async function main(): Promise<void> {
  if (process.env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (process.env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }
  if (isPinAIRuntimeToolEnabled(TOOL_NAME)) {
    throw new Error("PIN_AI_RUNTIME_EXTENSION_PRICE_TOOL_MUST_REMAIN_HIDDEN");
  }

  const reservations = await prisma.reservation.findMany({
    where: {
      status: "ACTIVE",
      totalAmount: { gt: 0 },
      property: { status: "ACTIVE" },
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
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
    throw new Error("PIN_AI_RUNTIME_STAGING_PRICED_ACTIVE_RESERVATION_NOT_FOUND");
  }

  const executor = new PinGoRuntimeReadToolExecutor(prisma);
  console.log("PIN_AI_RUNTIME_EXTENSION_PRICE_STARTED:DIRECT_READ_ONLY");

  for (const reservation of reservations) {
    const request: PinAIRuntimeRequest = {
      context: {
        organizationId: reservation.property.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        guestId: "runtime-shadow-extension-price-staging-guest",
        currentLocalDateTime: new Date().toISOString(),
        preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
      },
      conversation: [
        {
          role: "guest",
          content:
            reservation.preferredLanguage === "es"
              ? "¿Cuánto costaría quedarme una noche adicional?"
              : "How much would it cost to stay one additional night?",
        },
      ],
    };

    const result = await executor.execute(
      TOOL_NAME,
      { additionalNights: ADDITIONAL_NIGHTS },
      request,
      createConversationMemory(request),
    );

    if (result.priceCalculated !== true) {
      console.log(
        JSON.stringify({
          runtime: "pin-ai-v1",
          mode: "SHADOW_REAL_EXTENSION_PRICE_CANDIDATE_SKIPPED",
          reservationId: reservation.id,
          decision: result.decision,
        }),
      );
      continue;
    }

    assertReadOnlyPriceResult(result);

    console.log(
      JSON.stringify({
        runtime: "pin-ai-v1",
        mode: "SHADOW_REAL_EXTENSION_PRICE",
        model: null,
        scope: {
          organizationId: request.context.organizationId,
          propertyId: request.context.propertyId,
          reservationId: request.context.reservationId,
        },
        toolCalls: [
          {
            name: TOOL_NAME,
            arguments: { additionalNights: ADDITIONAL_NIGHTS },
          },
        ],
        result,
        authorizationGranted: false,
        actionsExecuted: false,
        databaseWrites: false,
        openAICalls: 0,
      }),
    );

    await prisma.$disconnect();
    return;
  }

  throw new Error("PIN_AI_RUNTIME_EXTENSION_PRICE_NO_ELIGIBLE_RESERVATION");
}

function assertReadOnlyPriceResult(
  result: Readonly<Record<string, unknown>>,
): void {
  if (
    result.authorizationGranted !== false ||
    result.chargeExecuted !== false ||
    result.reservationChanged !== false
  ) {
    throw new Error("PIN_AI_RUNTIME_EXTENSION_PRICE_READ_ONLY_INVARIANT_FAILED");
  }

  if (
    result.decision !== "PRICE_CALCULATED_FOR_REVIEW" &&
    result.decision !== "PRICE_REQUIRES_HUMAN_REVIEW"
  ) {
    throw new Error("PIN_AI_RUNTIME_EXTENSION_PRICE_DECISION_INVALID");
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_EXTENSION_PRICE_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
