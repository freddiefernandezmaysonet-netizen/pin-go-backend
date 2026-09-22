import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import type { PinAIRuntimeRequest } from "./contracts.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { GuardedPinAIModelAdapter } from "./model-adapter.js";
import { OpenAIAgentsRuntimeTransport } from "./openai-agents-runtime-transport.js";
import { createPinGoRuntimeReadToolExecutor } from "./pin-go-runtime-tools.js";
import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";
import { resolveWebSearchLocation } from "./web-search-location.js";

let openAIApiCalls = 0;
const openAIRequestIds: string[] = [];

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

  const { city, region, country, timezone, label: locationLabel } =
    resolveWebSearchLocation(reservation.property);
  if (!locationLabel) {
    throw new Error("PIN_AI_RUNTIME_STAGING_WEB_SEARCH_LOCATION_NOT_FOUND");
  }
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
          ? `Usa la búsqueda web en vivo para encontrar hasta tres restaurantes actuales en ${locationLabel}. También evalúa si puedo hacer checkout a la 1:00 PM y quedarme una noche adicional. Incluye enlaces a las fuentes. No confirmes horarios, precios ni disponibilidad, no reserves ni contactes a nadie, y no afirmes que el late checkout o la extensión fueron aprobados o ejecutados.`
          : `Use live web search to find up to three current restaurants in ${locationLabel}. Also evaluate whether I can check out at 1:00 PM and stay one additional night. Include source links. Do not confirm hours, prices, or availability, do not book or contact anyone, and do not claim the late checkout or extension was approved or executed.`,
      },
    ],
  };

  const guardedFetch = async (
    input: string,
    init: Readonly<{
      method: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ) => {
    openAIApiCalls += 1;
    if (openAIApiCalls > 60) {
      throw new Error("PIN_AI_RUNTIME_WEB_SEARCH_NETWORK_CALL_LIMIT");
    }

    const response = await fetch(input, init);
    const requestId = response.headers.get("x-request-id")?.trim() ?? "";
    if (/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
      openAIRequestIds.push(requestId);
    }
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json(),
    };
  };

  const observedToolResults: Array<
    Readonly<{
      name: string;
      decision: unknown;
      authorizationGranted: unknown;
      chargeExecuted: unknown;
      reservationChanged: unknown;
      actionsExecuted: unknown;
    }>
  > = [];
  const readTools = createPinGoRuntimeReadToolExecutor();
  const tools: PinAIRuntimeToolExecutor = {
    async execute(tool, args, runtimeRequest, memory) {
      const output = await readTools.execute(tool, args, runtimeRequest, memory);
      observedToolResults.push({
        name: tool,
        decision: output.decision,
        authorizationGranted: output.authorizationGranted,
        chargeExecuted: output.chargeExecuted,
        reservationChanged: output.reservationChanged,
        actionsExecuted: output.actionsExecuted,
      });

      if (
        (tool === "check_late_checkout" ||
          tool === "check_extension_availability" ||
          tool === "calculate_extension_price") &&
        output.authorizationGranted !== false
      ) {
        throw new Error(
          `PIN_AI_RUNTIME_COMBINED_CANARY_AUTHORIZATION_INVARIANT_FAILED:${tool}`,
        );
      }

      if (
        output.authorizationGranted === true ||
        output.chargeExecuted === true ||
        output.reservationChanged === true ||
        output.actionsExecuted === true
      ) {
        throw new Error(
          `PIN_AI_RUNTIME_COMBINED_CANARY_MUTATION_INVARIANT_FAILED:${tool}`,
        );
      }

      return output;
    },
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
      maxPolls: 50,
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
    tools,
  );

  if (
    response.webSearch?.enabled !== true ||
    response.webSearch.used !== true ||
    response.webSearch.callCount < 1
  ) {
    throw new Error("PIN_AI_RUNTIME_WEB_SEARCH_NOT_USED");
  }

  const functionToolCalls = response.toolCalls.map((call) => call.name);
  for (const requiredTool of [
    "check_late_checkout",
    "check_extension_availability",
  ] as const) {
    if (!functionToolCalls.includes(requiredTool)) {
      throw new Error(
        `PIN_AI_RUNTIME_COMBINED_CANARY_TOOL_NOT_CALLED:${requiredTool}`,
      );
    }
    const evidence = observedToolResults.find(
      (result) => result.name === requiredTool,
    );
    if (evidence?.authorizationGranted !== false) {
      throw new Error(
        `PIN_AI_RUNTIME_COMBINED_CANARY_AUTHORIZATION_INVARIANT_FAILED:${requiredTool}`,
      );
    }
  }

  if (response.escalationCreated !== false) {
    throw new Error("PIN_AI_RUNTIME_COMBINED_CANARY_ESCALATION_EXECUTED");
  }

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_WEB_SEARCH_ELIGIBILITY",
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
      functionToolCalls,
      observedToolResults,
      webSearch: response.webSearch,
      escalationCreated: response.escalationCreated,
      requiresHumanReview: response.requiresHumanReview,
      authorizationGranted: false,
      currentOpeningHoursVerified: false,
      currentPricesVerified: false,
      bookingExecuted: false,
      actionsExecuted: false,
      databaseWrites: false,
      openAIApiCalls,
      openAIRequestIds,
    }),
  );

  await prisma.$disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(
    `PIN_AI_RUNTIME_WEB_SEARCH_FAILED:${JSON.stringify({
      error: message,
      authorizationGranted: false,
      bookingExecuted: false,
      actionsExecuted: false,
      databaseWrites: false,
      openAIApiCalls,
      openAIRequestIds,
    })}`,
  );
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
