import type { PrismaClient } from "@prisma/client";
import type { PinAIRuntimeRequest } from "./contracts.js";
import { estimateStayTimeAdjustment } from "../../services/stay-time-estimate.service.js";
import { StayTimePolicyError, type StayTimeOperation } from "../actions/stay-time-policy.js";
import { StayTimeSettingsError } from "../actions/stay-time-settings.js";

const unavailable = (decision: string, reason: string) => ({
  decision, reason, authorizationGranted: false, actionExecuted: false,
  executionAvailable: false, paymentReady: false, availabilityHeld: false,
});

/** Identity comes exclusively from the gateway-authenticated request context. */
export async function checkStayTimeRequest(
  db: Pick<PrismaClient, "$transaction"> | undefined,
  operation: StayTimeOperation,
  args: Readonly<Record<string, unknown>>,
  request: PinAIRuntimeRequest,
  now = new Date(),
): Promise<Readonly<Record<string, unknown>>> {
  if (Object.keys(args).some(key => key !== "requestedLocalTime")) {
    return unavailable("INVALID_REQUEST", "UNSUPPORTED_STAY_TIME_ARGUMENTS");
  }
  const time = typeof args.requestedLocalTime === "string" ? args.requestedLocalTime.trim() : "";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return unavailable("REQUESTED_TIME_REQUIRED", "LOCAL_TIME_HH_MM_REQUIRED");
  }
  if (!db) return unavailable("UNAVAILABLE", "STAY_TIME_PROVIDER_UNAVAILABLE");
  try {
    const estimate = await estimateStayTimeAdjustment(db, {
      organizationId: request.context.organizationId,
      propertyId: request.context.propertyId,
      reservationId: request.context.reservationId,
      operation, requestedLocalTime: time,
    }, now);
    const spanish = request.context.preferredLanguage === "es";
    const { arrivalReadinessEvidenceId: _internalReadinessEvidence, ...guestEstimate } = estimate;
    return { ...guestEstimate, note: spanish
      ? "Estimación antes de impuestos. El horario no está reservado y la solicitud aún no puede confirmarse. No se modificó la reserva ni se realizó ningún cobro."
      : "Estimate before taxes. The time is not held and this request cannot yet be confirmed. No reservation change or charge was made." };
  } catch (error) {
    if (error instanceof StayTimePolicyError) {
      const decision = error.code === "ARRIVAL_READINESS_REQUIRED" ? "WAITING_FOR_CLEANING_READINESS"
        : error.code === "SERVICE_DISABLED" ? "SERVICE_DISABLED"
        : error.code === "TURNOVER_CONFLICT" ? "NOT_OPERATIONALLY_AVAILABLE"
        : "NOT_ELIGIBLE";
      return unavailable(decision, error.code);
    }
    if (error instanceof StayTimeSettingsError) return unavailable("UNAVAILABLE", "STAY_TIME_CONFIGURATION_REQUIRES_REVIEW");
    // Never expose database/provider errors or fall back to the old permissive check.
    return unavailable("UNAVAILABLE", "STAY_TIME_CHECK_FAILED");
  }
}
