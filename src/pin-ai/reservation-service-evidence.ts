import type { Prisma } from "@prisma/client";
import type { ActivationEnvironment } from "./property-activation.js";
import { pinAIConnectBillingAllows } from "./fee-connect.service.js";
import { recordPinAIReservationFeeInTransaction } from "./reservation-fee.service.js";
import { enrollPinAIServiceInTransaction } from "./service-enrollment.service.js";

// Call in the reservation's existing transaction. Database evidence only: no
// Stripe, emails, new transaction or worker dependency. Failures roll back with
// the reservation write, so a retry cannot commit an unevidenced commercial use.
export async function capturePinAIReservationService(tx: Prisma.TransactionClient, reservationId: string,
  env: ActivationEnvironment = process.env, now = new Date()) {
  if (env.PIN_AI_PROPERTY_ACTIVATION_ENABLED !== "true" || env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED !== "true" ||
    env.PIN_AI_CONNECT_DEBIT_ENABLED !== "true") return "DISABLED";
  // Serialize competing reservation mutations before checking current state.
  await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
  const r = await tx.reservation.findUnique({ where: { id: reservationId },
    select: { id: true, propertyId: true, property: { select: { organizationId: true } } } });
  if (!r || !pinAIConnectBillingAllows(env, r.property.organizationId)) return "DISABLED";
  const scope = { reservationId: r.id, propertyId: r.propertyId, organizationId: r.property.organizationId };
  const recorded = await recordPinAIReservationFeeInTransaction(tx, env, scope, now);
  if (recorded !== "NOT_ELIGIBLE") return recorded;
  return enrollPinAIServiceInTransaction(tx, env, scope, now);
}
