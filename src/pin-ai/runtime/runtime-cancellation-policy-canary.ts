import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import {
  isPinAIRuntimeToolEnabled,
  type PinAIRuntimeRequest,
} from "./contracts.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";

const TOOL_NAME = "get_cancellation_policy" as const;

async function main(): Promise<void> {
  if (process.env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (process.env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }
  if (isPinAIRuntimeToolEnabled(TOOL_NAME)) {
    throw new Error("PIN_AI_RUNTIME_CANCELLATION_POLICY_TOOL_MUST_REMAIN_HIDDEN");
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

  const executor = new PinGoRuntimeReadToolExecutor(prisma);
  console.log("PIN_AI_RUNTIME_CANCELLATION_POLICY_STARTED:DIRECT_READ_ONLY");

  for (const reservation of reservations) {
    const request: PinAIRuntimeRequest = {
      context: {
        organizationId: reservation.property.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        guestId: "runtime-shadow-cancellation-policy-staging-guest",
        currentLocalDateTime: new Date().toISOString(),
        preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
      },
      conversation: [
        {
          role: "guest",
          content:
            reservation.preferredLanguage === "es"
              ? "¿Qué ocurriría si cancelo mi reservación?"
              : "What would happen if I cancel my reservation?",
        },
      ],
    };

    const result = await executor.execute(
      TOOL_NAME,
      {},
      request,
      createConversationMemory(request),
    );

    if (result.decision !== "CANCELLATION_POLICY_EVALUATED") {
      console.log(
        JSON.stringify({
          runtime: "pin-ai-v1",
          mode: "SHADOW_REAL_CANCELLATION_POLICY_CANDIDATE_SKIPPED",
          reservationId: reservation.id,
          decision: result.decision,
        }),
      );
      continue;
    }

    assertReadOnlyPolicyResult(result);
    console.log(
      JSON.stringify({
        runtime: "pin-ai-v1",
        mode: "SHADOW_REAL_CANCELLATION_POLICY",
        model: null,
        scope: {
          organizationId: request.context.organizationId,
          propertyId: request.context.propertyId,
          reservationId: request.context.reservationId,
        },
        toolCalls: [{ name: TOOL_NAME, arguments: {} }],
        result,
        authorizationGranted: false,
        cancellationExecuted: false,
        refundExecuted: false,
        chargeExecuted: false,
        actionsExecuted: false,
        databaseWrites: false,
        openAICalls: 0,
      }),
    );

    await prisma.$disconnect();
    return;
  }

  throw new Error("PIN_AI_RUNTIME_CANCELLATION_POLICY_NO_VALID_SNAPSHOT");
}

function assertReadOnlyPolicyResult(
  result: Readonly<Record<string, unknown>>,
): void {
  if (
    result.authorizationGranted !== false ||
    result.cancellationExecuted !== false ||
    result.refundExecuted !== false ||
    result.chargeExecuted !== false ||
    !result.policy ||
    !result.evaluation
  ) {
    throw new Error(
      "PIN_AI_RUNTIME_CANCELLATION_POLICY_READ_ONLY_INVARIANT_FAILED",
    );
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_CANCELLATION_POLICY_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
