import type { Prisma, PrismaClient } from "@prisma/client";
import { PIN_AI_HYBRID_BILLING_TERMS as TERMS, pinAIHybridBillingAllows } from "./billing-terms.js";
import type { ActivationEnvironment } from "./property-activation.js";
import { hasDemoMarker } from "../services/internal-demo-scope.js";

const selection = { id: true, organizationId: true, status: true, isTestProperty: true, pinAIFeeExempt: true,
  pinAIEnabled: true, pinAITermsVersion: true, pinAITermsAcceptedAt: true, pinAITermsAcceptedBy: true,
  organization: { select: { pinAIEnabled: true, pinAIRevision: true } } } as const;
type Property = Prisma.PropertyGetPayload<{ select: typeof selection }>;
export function hybridFeeEligible(p: Property, env: ActivationEnvironment, now: Date) {
  return pinAIHybridBillingAllows(env, p.organizationId) && env.PIN_AI_PROPERTY_ACTIVATION_ENABLED === "true" &&
    env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED === "true" && p.status === "ACTIVE" && !p.isTestProperty &&
    !p.pinAIFeeExempt && p.pinAIEnabled && p.organization.pinAIEnabled && p.organization.pinAIRevision > 0 &&
    p.pinAITermsVersion === TERMS.version && !!p.pinAITermsAcceptedBy && !!p.pinAITermsAcceptedAt && p.pinAITermsAcceptedAt <= now;
}
export async function directPinAIFeeSnapshot(db: Pick<PrismaClient, "property">, env: ActivationEnvironment,
  propertyId: string, organizationId: string, now = new Date()) {
  const p = await db.property.findFirst({ where: { id: propertyId, organizationId }, select: selection });
  if (!p || !hybridFeeEligible(p, env, now)) return {} as Record<string, string>;
  return { pinAIFeeAmountCents: "100", pinAITermsVersion: TERMS.version,
    pinAITermsAcceptedBy: p.pinAITermsAcceptedBy!, pinAITermsAcceptedAt: p.pinAITermsAcceptedAt!.toISOString() };
}
// Called only on a new reservation, in the intake transaction. Never backfill
// historical bookings or charge an OTA update/cancellation as a new reservation.
export async function captureHybridMembershipFee(tx: Prisma.TransactionClient, env: ActivationEnvironment,
  reservationId: string, now: Date) {
  const r = await tx.reservation.findUnique({ where: { id: reservationId },
    include: { property: { select: selection } } });
  if (!r || r.status === "CANCELLED" || r.source === "DIRECT_BOOKING" ||
    r.externalProvider === "PIN_GO_DIRECT" || hasDemoMarker(r) || !hybridFeeEligible(r.property, env, now)) return "NOT_ELIGIBLE";
  const p = r.property;
  const sub = await tx.subscription.findUnique({ where: { organizationId: p.organizationId } });
  const result = await tx.pinAIReservationFee.createMany({ skipDuplicates: true, data: [{ reservationId,
    propertyId: p.id, organizationId: p.organizationId, amountCents: 100, currency: "USD", termsVersion: TERMS.version,
    acceptedBy: p.pinAITermsAcceptedBy!, acceptedAt: p.pinAITermsAcceptedAt!, serviceStartedAt: now,
    recordedAt: now, billingStatus: "PENDING_MEMBERSHIP", collectionMethod: "MEMBERSHIP",
    stripeCustomerId: sub?.stripeCustomerId, stripeSubscriptionId: sub?.stripeSubscriptionId }] });
  return result.count ? "RECORDED" : "ALREADY_RECORDED";
}
// This evidence survives rollout disablement and later changes to consent or
// exemption. A charged checkout must always be reconciled and reversible.
export async function captureDirectPinAIFee(db: PrismaClient, reservationId: string,
  metadata: Record<string, string> | null | undefined, now = new Date()) {
  if (metadata?.pinAIFeeAmountCents !== "100" || metadata.pinAITermsVersion !== TERMS.version) return;
  const acceptedAt = new Date(metadata.pinAITermsAcceptedAt ?? "");
  if (!metadata.pinAITermsAcceptedBy || !Number.isFinite(+acceptedAt) || acceptedAt > now)
    throw Error("PIN_AI_CHECKOUT_CONSENT_INVALID");
  return db.$transaction(async tx => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId },
      select: { propertyId: true, stripePaymentIntentId: true, stripeApplicationFeeId: true, stripeConnectedAccountId: true,
        property: { select: { organizationId: true } } } });
    if (r.propertyId !== metadata.propertyId || r.property.organizationId !== metadata.organizationId ||
      !r.stripePaymentIntentId || !r.stripeConnectedAccountId) throw Error("PIN_AI_CHECKOUT_SCOPE_INVALID");
    await tx.pinAIReservationFee.createMany({ skipDuplicates: true, data: [{ reservationId, propertyId: r.propertyId,
      organizationId: r.property.organizationId, amountCents: 100, currency: "USD", termsVersion: TERMS.version,
      acceptedBy: metadata.pinAITermsAcceptedBy!, acceptedAt, serviceStartedAt: now, recordedAt: now,
      collectionMethod: "DIRECT_APPLICATION_FEE", billingStatus: "PENDING_DIRECT_EVIDENCE",
      stripeConnectedAccountId: r.stripeConnectedAccountId, stripePaymentIntentId: r.stripePaymentIntentId,
      stripeApplicationFeeId: r.stripeApplicationFeeId }] });
  });
}
