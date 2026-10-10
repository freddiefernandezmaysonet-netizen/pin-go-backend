import type { PrismaClient } from "@prisma/client";
import { commercialPinAIEnabled, type ActivationEnvironment, type ActivationScope } from "../property-activation.js";
import { resolvePinAIActionCanaryScope } from "../actions/action-canary-scope.js";
import { guestPinAIAvailability } from "./guest-availability.js";

// Commercial date changes use the host's Pin AI activation, independently of
// hourly stay-time settings. The canonical services still enforce availability,
// pricing, guest consent and verified payment before changing a reservation.
export async function commercialReservationChangesEnabled(
  db: Pick<PrismaClient, "property" | "reservation">,
  env: ActivationEnvironment,
  scope: ActivationScope & { reservationId: string },
  now = new Date(),
): Promise<boolean> {
  if (env.PIN_AI_ACTION_BROKER_ENABLED !== "true" || env.PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED !== "true") return false;
  if (env.PIN_AI_ALL_ORGANIZATIONS_ENABLED !== "true" || env.PIN_AI_PROPERTY_ACTIVATION_ENABLED !== "true") {
    return resolvePinAIActionCanaryScope({ reservationId: scope.reservationId, env }).enabled;
  }
  if (await commercialPinAIEnabled(db, env, scope) !== true) return false;
  const reservation = await db.reservation.findFirst({
    where: { id: scope.reservationId, propertyId: scope.propertyId, property: { organizationId: scope.organizationId } },
    select: { status: true, paymentState: true, source: true, externalProvider: true,
      checkIn: true, checkOut: true, property: { select: { isPublicBookable: true,
        pinAITermsAcceptedAt: true, pinAITermsAcceptedBy: true } } },
  });
  return !!reservation && reservation.paymentState === "PAID" &&
    (reservation.source === "DIRECT_BOOKING" || reservation.externalProvider === "PIN_GO_DIRECT") &&
    reservation.checkOut > now && guestPinAIAvailability(reservation, now).available &&
    reservation.property.isPublicBookable === true && !!reservation.property.pinAITermsAcceptedAt &&
    reservation.property.pinAITermsAcceptedAt <= now && !!reservation.property.pinAITermsAcceptedBy;
}
