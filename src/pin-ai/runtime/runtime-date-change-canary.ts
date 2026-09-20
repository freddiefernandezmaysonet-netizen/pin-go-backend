import { formatInTimeZone } from "date-fns-tz";

import { prisma } from "../../lib/prisma.js";
import { createConversationMemory } from "./conversation-memory.js";
import {
  isPinAIRuntimeToolEnabled,
  type PinAIRuntimeRequest,
} from "./contracts.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";

const TOOL_NAME = "check_date_change" as const;
const MAX_SHIFT_DAYS = 30;

async function main(): Promise<void> {
  if (process.env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (process.env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }
  if (isPinAIRuntimeToolEnabled(TOOL_NAME)) {
    throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_TOOL_MUST_REMAIN_HIDDEN");
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

  const executor = new PinGoRuntimeReadToolExecutor(prisma);
  const now = new Date();
  console.log("PIN_AI_RUNTIME_DATE_CHANGE_STARTED:DIRECT_READ_ONLY");

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
        guestId: "runtime-shadow-date-change-staging-guest",
        currentLocalDateTime: now.toISOString(),
        preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
      },
      conversation: [
        {
          role: "guest",
          content:
            reservation.preferredLanguage === "es"
              ? "¿Puedo mover toda mi estadía a otras fechas?"
              : "Can I move my entire stay to different dates?",
        },
      ],
    };

    for (let shiftDays = 1; shiftDays <= MAX_SHIFT_DAYS; shiftDays += 1) {
      const proposedCheckInDate = shiftDateKey(todayDate, shiftDays);
      const proposedCheckOutDate = shiftDateKey(
        proposedCheckInDate,
        stayNights,
      );
      const result = await executor.execute(
        TOOL_NAME,
        { proposedCheckInDate, proposedCheckOutDate },
        request,
        createConversationMemory(request),
      );

      if (result.priceCalculated !== true) {
        console.log(
          JSON.stringify({
            runtime: "pin-ai-v1",
            mode: "SHADOW_REAL_DATE_CHANGE_CANDIDATE_SKIPPED",
            reservationId: reservation.id,
            shiftDays,
            decision: result.decision,
            reason: result.reason ?? null,
          }),
        );
        continue;
      }

      assertReadOnlyDateChangeResult(result);
      console.log(
        JSON.stringify({
          runtime: "pin-ai-v1",
          mode: "SHADOW_REAL_DATE_CHANGE",
          model: null,
          scope: {
            organizationId: request.context.organizationId,
            propertyId: request.context.propertyId,
            reservationId: request.context.reservationId,
          },
          toolCalls: [
            {
              name: TOOL_NAME,
              arguments: { proposedCheckInDate, proposedCheckOutDate },
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
  }

  throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_NO_ELIGIBLE_RESERVATION");
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

function assertReadOnlyDateChangeResult(
  result: Readonly<Record<string, unknown>>,
): void {
  if (
    result.decision !== "DATE_CHANGE_AVAILABLE_FOR_REVIEW" ||
    result.authorizationGranted !== false ||
    result.priceCalculated !== true ||
    result.requiresHumanReview !== true ||
    result.chargeExecuted !== false ||
    result.refundExecuted !== false ||
    result.reservationChanged !== false
  ) {
    throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_READ_ONLY_INVARIANT_FAILED");
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_DATE_CHANGE_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
