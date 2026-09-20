import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import {
  isPinAIRuntimeToolEnabled,
  type PinAIRuntimeRequest,
} from "./contracts.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";

const TOOL_NAME = "search_local_places" as const;

async function main(): Promise<void> {
  if (process.env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (process.env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }
  if (!String(process.env.GOOGLE_MAPS_SERVER_API_KEY ?? "").trim()) {
    throw new Error("PIN_AI_RUNTIME_GOOGLE_PLACES_API_KEY_MISSING");
  }
  if (isPinAIRuntimeToolEnabled(TOOL_NAME)) {
    throw new Error("PIN_AI_RUNTIME_LOCAL_PLACES_TOOL_MUST_REMAIN_HIDDEN");
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      status: "ACTIVE",
      property: {
        status: "ACTIVE",
        latitude: { not: null },
        longitude: { not: null },
      },
    },
    orderBy: { updatedAt: "desc" },
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
  if (!reservation) {
    throw new Error("PIN_AI_RUNTIME_STAGING_LOCAL_PLACES_CONTEXT_NOT_FOUND");
  }

  const request: PinAIRuntimeRequest = {
    context: {
      organizationId: reservation.property.organizationId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      guestId: "runtime-shadow-local-places-staging-guest",
      currentLocalDateTime: new Date().toISOString(),
      preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
    },
    conversation: [
      {
        role: "guest",
        content:
          reservation.preferredLanguage === "es"
            ? "¿Hay comida puertorriqueña cerca?"
            : "Is there Puerto Rican food nearby?",
      },
    ],
  };

  console.log("PIN_AI_RUNTIME_LOCAL_PLACES_STARTED:DIRECT_EXTERNAL_READ_ONLY");
  const result = await new PinGoRuntimeReadToolExecutor(prisma).execute(
    TOOL_NAME,
    { query: "Puerto Rican food", radiusMeters: 15_000, maxResults: 5 },
    request,
    createConversationMemory(request),
  );

  if (
    result.decision !== "LOCAL_PLACES_SEARCH_COMPLETED" ||
    result.authorizationGranted !== false ||
    result.externalReadPerformed !== true ||
    result.currentOpeningHoursVerified !== false ||
    result.currentPricesVerified !== false ||
    result.bookingExecuted !== false ||
    result.actionsExecuted !== false ||
    !Array.isArray(result.places)
  ) {
    throw new Error("PIN_AI_RUNTIME_LOCAL_PLACES_READ_ONLY_INVARIANT_FAILED");
  }

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_REAL_LOCAL_PLACES",
      model: null,
      scope: {
        organizationId: request.context.organizationId,
        propertyId: request.context.propertyId,
        reservationId: request.context.reservationId,
      },
      toolCalls: [
        {
          name: TOOL_NAME,
          arguments: {
            query: "Puerto Rican food",
            radiusMeters: 15_000,
            maxResults: 5,
          },
        },
      ],
      result,
      authorizationGranted: false,
      bookingExecuted: false,
      actionsExecuted: false,
      databaseWrites: false,
      googlePlacesCalls: 1,
      openAICalls: 0,
    }),
  );

  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_LOCAL_PLACES_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
