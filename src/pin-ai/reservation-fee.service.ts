import type { Prisma, PrismaClient } from "@prisma/client";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";
import { guestPinAIAvailability } from "./guest/guest-availability.js";
import { hasDemoMarker } from "../services/internal-demo-scope.js";
import type { ActivationEnvironment, ActivationScope } from "./property-activation.js";
import { pinAIConnectBillingAllows } from "./fee-connect.service.js";

export function pinAIFeeBookingKind(r: { source: string | null; externalProvider: string | null }) {
  if (hasDemoMarker(r)) return null;
  if (r.source === "DIRECT_BOOKING") return "DIRECT_BOOKING";
  if (r.externalProvider === "CHANNEX") return "OTA";
  return "OTHER"; // Billing is independent of messaging capability and origin.
}

// Local accrual only. Never creates a Stripe charge, invoice or email. Disabled
// until the Connect rollout is explicitly enabled. No chat interaction required.
export async function recordPinAIReservationFee(db: PrismaClient, env: ActivationEnvironment,
  scope: ActivationScope & { reservationId: string }, now = new Date()) {
  if (env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED !== "true" || env.PIN_AI_PROPERTY_ACTIVATION_ENABLED !== "true" ||
    !pinAIConnectBillingAllows(env, scope.organizationId)) return "DISABLED";
  return db.$transaction(tx => recordPinAIReservationFeeInTransaction(tx, env, scope, now), { isolationLevel: "Serializable" });
}

export async function recordPinAIReservationFeeInTransaction(tx: Prisma.TransactionClient, env: ActivationEnvironment,
  scope: ActivationScope & { reservationId: string }, now = new Date()) {
  if (env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED !== "true" || env.PIN_AI_PROPERTY_ACTIVATION_ENABLED !== "true" ||
    !pinAIConnectBillingAllows(env, scope.organizationId)) return "DISABLED";
  const r = await tx.reservation.findFirst({ where: { id: scope.reservationId, propertyId: scope.propertyId,
    property: { organizationId: scope.organizationId } }, include: { property: { include: { organization: true } } } });
  if (!r || !guestPinAIAvailability(r, now).available) return "NOT_ELIGIBLE";
  const p = r.property;
  const kind = pinAIFeeBookingKind(r);
  if (!kind || p.isTestProperty || p.status !== "ACTIVE" || !p.pinAIEnabled || !p.organization.pinAIEnabled ||
    p.organization.pinAIRevision === 0 || p.pinAITermsVersion !== PIN_AI_BILLING_TERMS.version ||
    !p.pinAITermsAcceptedAt || !p.pinAITermsAcceptedBy || p.pinAITermsAcceptedAt > now ||
    !p.organization.stripeConnectAccountId) return "NOT_ELIGIBLE";
  const result = await tx.pinAIReservationFee.createMany({ skipDuplicates: true, data: [{
    ...scope, amountCents: PIN_AI_BILLING_TERMS.amountCents, currency: PIN_AI_BILLING_TERMS.currency,
    termsVersion: PIN_AI_BILLING_TERMS.version, acceptedBy: p.pinAITermsAcceptedBy, acceptedAt: p.pinAITermsAcceptedAt,
    serviceStartedAt: now, recordedAt: now, billingStatus: "PENDING_CONNECT",
    stripeConnectedAccountId: p.organization.stripeConnectAccountId,
  }] });
  return result.count === 1 ? "RECORDED" : "ALREADY_RECORDED";

}
