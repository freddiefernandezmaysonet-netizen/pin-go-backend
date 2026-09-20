import { formatInTimeZone } from "date-fns-tz";

import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import type { PinAIRuntimeRequest } from "./contracts.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { GuardedPinAIModelAdapter } from "./model-adapter.js";
import { OpenAIAgentsRuntimeTransport } from "./openai-agents-runtime-transport.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";
import { createPinGoRuntimeReadToolExecutor } from "./pin-go-runtime-tools.js";

const MAX_SHIFT_DAYS = 30;

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
      property: { status: "ACTIVE" },
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: {
      id: true,
      propertyId: true,
      preferredLanguage: true,
      checkIn: true,
      checkOut: true,
      property: {
        select: {
          organizationId: true,
          timezone: true,
        },
      },
    },
  });
  if (reservations.length === 0) {
    throw new Error("PIN_AI_RUNTIME_STAGING_PRICED_ACTIVE_RESERVATION_NOT_FOUND");
  }

  const candidate = await findAvailableCandidate(reservations);
  if (!candidate) {
    throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_NO_ELIGIBLE_RESERVATION");
  }

  const request: PinAIRuntimeRequest = {
    context: {
      organizationId: candidate.organizationId,
      propertyId: candidate.propertyId,
      reservationId: candidate.reservationId,
      guestId: "runtime-shadow-date-change-luna-staging-guest",
      currentLocalDateTime: candidate.currentLocalDateTime,
      preferredLanguage: candidate.preferredLanguage,
    },
    conversation: [
      {
        role: "guest",
        content:
          candidate.preferredLanguage === "es"
            ? `Quiero mover toda mi estadía, no extenderla. Las nuevas fechas serían entrada ${candidate.proposedCheckInDate} y salida ${candidate.proposedCheckOutDate}. ¿Está disponible y cuál sería el precio estimado?`
            : `I want to move my entire stay, not extend it. The new dates would be check-in ${candidate.proposedCheckInDate} and check-out ${candidate.proposedCheckOutDate}. Is that available, and what would the estimated price be?`,
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
      throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_NETWORK_CALL_LIMIT");
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

  console.log("PIN_AI_RUNTIME_DATE_CHANGE_LUNA_STARTED:gpt-5.6-luna");
  const response = await model.run(
    request,
    createConversationMemory(request),
    createPinGoRuntimeReadToolExecutor(),
  );

  const dateChangeCall = response.toolCalls.find(
    (call) => call.name === "check_date_change",
  );
  if (!dateChangeCall) {
    throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_TOOL_NOT_CALLED");
  }
  if (
    dateChangeCall.arguments.proposedCheckInDate !==
      candidate.proposedCheckInDate ||
    dateChangeCall.arguments.proposedCheckOutDate !==
      candidate.proposedCheckOutDate
  ) {
    throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_ARGUMENTS_INVALID");
  }
  if (
    response.toolCalls.some(
      (call) =>
        call.name === "check_extension_availability" ||
        call.name === "calculate_extension_price",
    )
  ) {
    throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_ROUTED_AS_EXTENSION");
  }
  if (
    response.escalationCreated !== false ||
    response.requiresHumanReview !== true
  ) {
    throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_SHADOW_INVARIANT_FAILED");
  }

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_REAL_DATE_CHANGE_LUNA",
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
      chargeExecuted: false,
      refundExecuted: false,
      reservationChanged: false,
      actionsExecuted: false,
      databaseWrites: false,
      outboundCalls,
    }),
  );

  await prisma.$disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function findAvailableCandidate(
  reservations: readonly any[],
): Promise<Readonly<{
  organizationId: string;
  propertyId: string;
  reservationId: string;
  preferredLanguage: "en" | "es";
  currentLocalDateTime: string;
  proposedCheckInDate: string;
  proposedCheckOutDate: string;
}> | null> {
  const executor = new PinGoRuntimeReadToolExecutor(prisma);
  const now = new Date();

  for (const reservation of reservations) {
    const timezone = String(reservation.property.timezone ?? "").trim();
    if (!timezone) continue;

    const currentCheckInDate = formatInTimeZone(
      reservation.checkIn,
      timezone,
      "yyyy-MM-dd",
    );
    const currentCheckOutDate = formatInTimeZone(
      reservation.checkOut,
      timezone,
      "yyyy-MM-dd",
    );
    const stayNights = dateKeyDifference(
      currentCheckInDate,
      currentCheckOutDate,
    );
    if (stayNights < 1) continue;

    const todayDate = formatInTimeZone(now, timezone, "yyyy-MM-dd");
    const request: PinAIRuntimeRequest = {
      context: {
        organizationId: reservation.property.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        guestId: "runtime-shadow-date-change-preflight-guest",
        currentLocalDateTime: now.toISOString(),
        preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
      },
      conversation: [{ role: "guest", content: "Date-change preflight." }],
    };

    for (let shiftDays = 1; shiftDays <= MAX_SHIFT_DAYS; shiftDays += 1) {
      const proposedCheckInDate = shiftDateKey(todayDate, shiftDays);
      const proposedCheckOutDate = shiftDateKey(
        proposedCheckInDate,
        stayNights,
      );
      const result = await executor.execute(
        "check_date_change",
        { proposedCheckInDate, proposedCheckOutDate },
        request,
        createConversationMemory(request),
      );
      if (result.priceCalculated === true) {
        return {
          organizationId: request.context.organizationId,
          propertyId: request.context.propertyId,
          reservationId: request.context.reservationId,
          preferredLanguage: request.context.preferredLanguage ?? "en",
          currentLocalDateTime: request.context.currentLocalDateTime,
          proposedCheckInDate,
          proposedCheckOutDate,
        };
      }
    }
  }

  return null;
}

function shiftDateKey(dateKey: string, days: number): string {
  const shifted = new Date(`${dateKey}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function dateKeyDifference(startDateKey: string, endDateKey: string): number {
  return Math.round(
    (Date.parse(`${endDateKey}T00:00:00.000Z`) -
      Date.parse(`${startDateKey}T00:00:00.000Z`)) /
      86_400_000,
  );
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_DATE_CHANGE_LUNA_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
