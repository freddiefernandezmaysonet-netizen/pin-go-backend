import type { PrismaClient } from "@prisma/client";
import type { PinAIRuntimeRequest } from "./contracts.js";
import { estimateStayTimeAdjustment } from "../../services/stay-time-estimate.service.js";
import { StayTimePolicyError, type StayTimeOperation } from "../actions/stay-time-policy.js";
import { StayTimeSettingsError } from "../actions/stay-time-settings.js";

const unavailable = (decision: string, reason: string) => ({
  decision, reason, authorizationGranted: false, actionExecuted: false,
  executionAvailable: false, paymentReady: false, availabilityHeld: false,
});

function cleaningRejectionNote(reason: string, spanish: boolean) {
  switch (reason) {
    case "DEPARTURE_CLEANING_COMMITMENT_REQUIRED":
      return spanish
        ? "Aún no puedo verificar un compromiso de limpieza confirmado y vigente para esta salida. La solicitud puede volver a evaluarse cuando se valide ese compromiso."
        : "I cannot yet verify a confirmed and current cleaning commitment for this checkout. The request can be evaluated again once that commitment is validated.";
    case "ARRIVAL_READINESS_REQUIRED":
      return spanish
        ? "La preparación de la propiedad para la llegada aún no está verificada. La solicitud puede volver a evaluarse cuando se confirme que está lista."
        : "The property's arrival readiness is not yet verified. The request can be evaluated again once readiness is confirmed.";
    case "CLEANING_CHECKIN_LIMIT_EXCEEDED":
      return spanish
        ? "El horario solicitado, más el margen de inicio y la duración de limpieza, excede la hora estándar de entrada de la propiedad. Este límite se aplica aunque no haya otra llegada reservada."
        : "The requested time, plus the cleaning start offset and duration, exceeds the property's standard check-in time. This limit applies even when no other arrival is booked.";
    case "TURNOVER_CONFLICT":
      return spanish
        ? "Hay un conflicto de disponibilidad en el intervalo necesario para el cambio y la limpieza. La consulta no identifica aquí si corresponde a otra reserva, un bloqueo o una solicitud de cambio pendiente."
        : "There is an availability conflict in the interval needed for the change and cleaning. This check does not identify here whether it is another reservation, a block or a pending change request.";
    default:
      return undefined;
  }
}

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
    const { arrivalReadinessEvidenceId: _internalReadinessEvidence,
      departureCleaning: _internalDepartureCleaning, ...guestEstimate } = estimate;
    return { ...guestEstimate, note: spanish
      ? "Estimación antes de impuestos. El horario no está reservado y la solicitud aún no puede confirmarse. No se modificó la reserva ni se realizó ningún cobro."
      : "Estimate before taxes. The time is not held and this request cannot yet be confirmed. No reservation change or charge was made." };
  } catch (error) {
    if (error instanceof StayTimePolicyError) {
      const decision = error.code === "ARRIVAL_READINESS_REQUIRED" ? "WAITING_FOR_CLEANING_READINESS"
        : error.code === "SERVICE_DISABLED" ? "SERVICE_DISABLED"
        : error.code === "TURNOVER_CONFLICT" ? "NOT_OPERATIONALLY_AVAILABLE"
        : "NOT_ELIGIBLE";
      const note = cleaningRejectionNote(error.code, request.context.preferredLanguage === "es");
      return { ...unavailable(decision, error.code), ...(note ? { note } : {}) };
    }
    if (error instanceof StayTimeSettingsError) return unavailable("UNAVAILABLE", "STAY_TIME_CONFIGURATION_REQUIRES_REVIEW");
    // Never expose database/provider errors or fall back to the old permissive check.
    return unavailable("UNAVAILABLE", "STAY_TIME_CHECK_FAILED");
  }
}
