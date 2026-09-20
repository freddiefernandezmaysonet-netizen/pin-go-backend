import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import type { PinAIRuntimeRequest } from "./contracts.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { GuardedPinAIModelAdapter } from "./model-adapter.js";
import { OpenAIAgentsRuntimeTransport } from "./openai-agents-runtime-transport.js";
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

  const reservation = await prisma.reservation.findFirst({
    where: {
      status: "ACTIVE",
      property: {
        status: "ACTIVE",
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
          city: true,
          region: true,
          country: true,
          timezone: true,
        },
      },
    },
  });
  if (!reservation) {
    throw new Error("PIN_AI_RUNTIME_STAGING_WEB_SEARCH_CONTEXT_NOT_FOUND");
  }

  const city = boundedLocationPart(reservation.property.city);
  const region = boundedLocationPart(reservation.property.region);
  const country = normalizeCountry(reservation.property.country);
  const timezone = boundedLocationPart(reservation.property.timezone);
  if (!city && !region && !country) {
    throw new Error("PIN_AI_RUNTIME_STAGING_WEB_SEARCH_LOCATION_NOT_FOUND");
  }
  const locationLabel = [city, region, country].filter(Boolean).join(", ");
  const spanish = reservation.preferredLanguage === "es";

  const request: PinAIRuntimeRequest = {
    context: {
      organizationId: reservation.property.organizationId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      guestId: "runtime-shadow-web-search-staging-guest",
      currentLocalDateTime: new Date().toISOString(),
      preferredLanguage: spanish ? "es" : "en",
    },
    conversation: [
      {
        role: "guest",
        content: spanish
          ? `Usa la búsqueda web en vivo para encontrar hasta tres restaurantes actuales en ${locationLabel}. Incluye enlaces a las fuentes. No confirmes horarios, precios ni disponibilidad y no reserves ni contactes a nadie.`
          : `Use live web search to find up to three current restaurants in ${locationLabel}. Include source links. Do not confirm hours, prices, or availability, and do not book or contact anyone.`,
      },
    ],
  };

  let openAIApiCalls = 0;
  const guardedFetch = async (
    input: string,
    init: Readonly<{
      method: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ) => {
    openAIApiCalls += 1;
    if (openAIApiCalls > 40) {
      throw new Error("PIN_AI_RUNTIME_WEB_SEARCH_NETWORK_CALL_LIMIT");
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
      webSearch: {
        enabled: true,
        mode: "live",
        location: {
          ...(country ? { country } : {}),
          ...(region ? { region } : {}),
          ...(city ? { city } : {}),
          ...(timezone ? { timezone } : {}),
        },
      },
      maxPolls: 30,
      pollDelayMs: 500,
    },
    guardedFetch,
  );
  const model = new GuardedPinAIModelAdapter(
    new LunaRuntimeAdapter(transport),
  );

  console.log("PIN_AI_RUNTIME_WEB_SEARCH_STARTED:gpt-5.6-luna");
  const response = await model.run(
    request,
    createConversationMemory(request),
    createPinGoRuntimeReadToolExecutor(),
  );

  if (
    response.webSearch?.enabled !== true ||
    response.webSearch.used !== true ||
    response.webSearch.callCount < 1
  ) {
    throw new Error("PIN_AI_RUNTIME_WEB_SEARCH_NOT_USED");
  }

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_WEB_SEARCH",
      model: "gpt-5.6-luna",
      scope: {
        organizationId: request.context.organizationId,
        propertyId: request.context.propertyId,
        reservationId: request.context.reservationId,
        location: {
          city,
          region: region || null,
          country: country || null,
        },
      },
      responseText: response.responseText,
      functionToolCalls: response.toolCalls.map((call) => call.name),
      webSearch: response.webSearch,
      authorizationGranted: false,
      currentOpeningHoursVerified: false,
      currentPricesVerified: false,
      bookingExecuted: false,
      actionsExecuted: false,
      databaseWrites: false,
      openAIApiCalls,
    }),
  );

  await prisma.$disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

function boundedLocationPart(value: string | null): string {
  return String(value ?? "").trim().slice(0, 100);
}

function normalizeCountry(value: string | null): string {
  const country = boundedLocationPart(value);
  if (/^(puerto rico|pr)$/i.test(country)) return "PR";
  return /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : "";
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_WEB_SEARCH_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
