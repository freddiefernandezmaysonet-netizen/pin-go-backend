import type { PrismaClient } from "@prisma/client";
import { commercialPinAIEnabled, type ActivationScope, type ActivationEnvironment } from "../property-activation.js";
import { parseStayTimeSettings } from "../actions/stay-time-settings.js";
import { guestPinAIAvailability } from "./guest-availability.js";
import { resolvePinAIActionCanaryScope } from "../actions/action-canary-scope.js";

// Commercial stay-time scope is separate from ordinary date modifications.
// Preserve the selected-reservation pilot when commercial controls are off.
export async function commercialStayTimeChatEnabled(db: Pick<PrismaClient, "property" | "reservation">,
  env: ActivationEnvironment, scope: ActivationScope & { reservationId: string }, now = new Date()): Promise<boolean> {
  if (env.PIN_AI_STAY_TIME_CHAT_ENABLED !== "true" || env.PIN_AI_ACTION_BROKER_ENABLED !== "true" ||
      env.PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED !== "true") return false;
  if (env.PIN_AI_ALL_ORGANIZATIONS_ENABLED !== "true" || env.PIN_AI_PROPERTY_ACTIVATION_ENABLED !== "true")
    return resolvePinAIActionCanaryScope({ reservationId: scope.reservationId, env }).enabled;
  if (await commercialPinAIEnabled(db, env, scope) !== true) return false;
  const reservation = await db.reservation.findFirst({ where: { id: scope.reservationId, propertyId: scope.propertyId,
    property: { organizationId: scope.organizationId } }, select: { status: true, checkIn: true, checkOut: true,
      property: { select: { stayTimeSettings: true, pinAITermsAcceptedAt: true, pinAITermsAcceptedBy: true } } } });
  if (!reservation || !guestPinAIAvailability(reservation, now).available ||
      !reservation.property.pinAITermsAcceptedAt || reservation.property.pinAITermsAcceptedAt > now ||
      !reservation.property.pinAITermsAcceptedBy || !reservation.property.stayTimeSettings) return false;
  try {
    const settings = parseStayTimeSettings(reservation.property.stayTimeSettings);
    return settings.earlyCheckin.enabled || settings.lateCheckout.enabled;
  } catch { return false; }
}
