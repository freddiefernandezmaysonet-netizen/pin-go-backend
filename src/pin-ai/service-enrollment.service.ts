import type { Prisma, PrismaClient } from "@prisma/client";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";
import { guestPinAIAvailability } from "./guest/guest-availability.js";
import { pinAIFeeBookingKind } from "./reservation-fee.service.js";
import { pinAIConnectBillingAllows } from "./fee-connect.service.js";
import type { ActivationEnvironment, ActivationScope } from "./property-activation.js";

const enabled = (env: ActivationEnvironment, org: string) =>
  env.PIN_AI_PROPERTY_ACTIVATION_ENABLED === "true" && env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED === "true" &&
  pinAIConnectBillingAllows(env, org);

// A scheduled enrollment is eligibility evidence, never a payable fee. Save it
// before opening so a later outage does not require guessing historical state.
export async function enrollPinAIService(db: PrismaClient, env: ActivationEnvironment,
  scope: ActivationScope & { reservationId: string }, now = new Date()) {
  if (!enabled(env, scope.organizationId)) return "DISABLED";
  return db.$transaction(tx => enrollPinAIServiceInTransaction(tx, env, scope, now), { isolationLevel: "Serializable" });
}

export async function enrollPinAIServiceInTransaction(tx: Prisma.TransactionClient, env: ActivationEnvironment,
  scope: ActivationScope & { reservationId: string }, now = new Date()) {
  if (!enabled(env, scope.organizationId)) return "DISABLED";
  const r = await tx.reservation.findFirst({ where: { id: scope.reservationId, propertyId: scope.propertyId,
    property: { organizationId: scope.organizationId } }, include: { property: { include: { organization: true } } } });
  if (!r || r.status !== "ACTIVE" || !pinAIFeeBookingKind(r)) return "NOT_ELIGIBLE";
  const p = r.property, o = p.organization;
  if (p.pinAIFeeExempt) return "EXEMPT";
  const { opensAt, closesAt } = guestPinAIAvailability(r, now);
  if (!opensAt || !closesAt || now >= opensAt || p.isTestProperty || p.status !== "ACTIVE" ||
    !p.pinAIEnabled || !o.pinAIEnabled || !p.pinAIRevision || !o.pinAIRevision ||
    p.pinAITermsVersion !== PIN_AI_BILLING_TERMS.version || !p.pinAITermsAcceptedAt ||
    p.pinAITermsAcceptedAt > now || !p.pinAITermsAcceptedBy || !o.stripeConnectAccountId) return "NOT_ELIGIBLE";
  const result = await tx.pinAIServiceEnrollment.createMany({ skipDuplicates: true, data: [{ ...scope,
    stripeConnectedAccountId: o.stripeConnectAccountId, termsVersion: p.pinAITermsVersion,
    acceptedBy: p.pinAITermsAcceptedBy, acceptedAt: p.pinAITermsAcceptedAt, enrolledAt: now,
    checkIn: r.checkIn, checkOut: r.checkOut, opensAt, closesAt,
    propertyRevision: p.pinAIRevision, organizationRevision: o.pinAIRevision,
  }] });
  return result.count === 1 ? "ENROLLED" : "ALREADY_ENROLLED";

}

export async function accrueEnrolledPinAIFee(db: PrismaClient, env: ActivationEnvironment,
  reservationId: string, now = new Date()) {
  return db.$transaction(async tx => {
    const e = await tx.pinAIServiceEnrollment.findUnique({ where: { reservationId } });
    if (!e || !enabled(env, e.organizationId)) return "DISABLED";
    const property = await tx.property.findFirst({ where: { id: e.propertyId, organizationId: e.organizationId },
      select: { pinAIFeeExempt: true } });
    if (property?.pinAIFeeExempt) {
      if (e.status === "SCHEDULED") await tx.pinAIServiceEnrollment.update({ where: { reservationId },
        data: { status: "EXCLUDED", reason: "PROPERTY_FEE_EXEMPT", resolvedAt: now } });
      return "EXEMPT";
    }
    if (e.status !== "SCHEDULED") return e.status;
    if (now < e.opensAt) return "NOT_DUE";
    const finish = async (status: string, reason: string | null) => {
      await tx.pinAIServiceEnrollment.update({ where: { reservationId }, data: { status, reason, resolvedAt: now } });
      return status;
    };
    const r = await tx.reservation.findUnique({ where: { id: reservationId }, include: { property: { include: { organization: true } } } });
    if (!r || r.propertyId !== e.propertyId || r.property.organizationId !== e.organizationId ||
      +r.checkIn !== +e.checkIn || +r.checkOut !== +e.checkOut || !pinAIFeeBookingKind(r) || r.property.isTestProperty ||
      r.property.organization.stripeConnectAccountId !== e.stripeConnectedAccountId ||
      e.termsVersion !== PIN_AI_BILLING_TERMS.version || e.acceptedAt > e.enrolledAt || e.enrolledAt >= e.opensAt)
      return finish("NEEDS_REVIEW", "SERVICE_SNAPSHOT_CHANGED");
    if (r.status === "CANCELLED") {
      if (!r.cancelledAt || r.cancelledAt > now) return finish("NEEDS_REVIEW", "CANCELLATION_TIME_UNCERTAIN");
      if (r.cancelledAt <= e.opensAt) return finish("EXCLUDED", "CANCELLED_BEFORE_SERVICE");
    } else if (r.status !== "ACTIVE") return finish("NEEDS_REVIEW", "RESERVATION_STATE_UNCERTAIN");
    // Every managed activation change is atomically audited. A change before
    // opening invalidates the planned eligibility instead of guessing intent.
    const changes = await tx.apmsAuditEntry.findMany({ where: { organizationId: e.organizationId,
      engine: "PIN_AI_ACTIVATION", eventType: "SET_ENABLED", status: "APPLIED",
      createdAt: { gte: e.enrolledAt, lte: now },
      OR: [{ entityType: "PROPERTY", entityId: e.propertyId }, { entityType: "ORGANIZATION", entityId: e.organizationId }],
    }, select: { entityType: true, metadata: true, createdAt: true } });
    for (const [entityType, initial, current, currentEnabled] of [
      ["PROPERTY", e.propertyRevision, r.property.pinAIRevision, r.property.pinAIEnabled],
      ["ORGANIZATION", e.organizationRevision, r.property.organization.pinAIRevision, r.property.organization.pinAIEnabled],
    ] as const) {
      const events = changes.filter(c => c.entityType === entityType);
      const revisions = new Map<number, Date>();
      for (const c of events) {
        const metadata = c.metadata as { revision?: number } | null;
        if (!metadata || !Number.isSafeInteger(metadata.revision))
          return finish("NEEDS_REVIEW", "ACTIVATION_HISTORY_UNCERTAIN");
        if (Number(metadata.revision) > initial) revisions.set(Number(metadata.revision), c.createdAt);
      }
      if (current < initial || (current === initial && !currentEnabled) || revisions.size !== current - initial)
        return finish("NEEDS_REVIEW", "ACTIVATION_HISTORY_UNCERTAIN");
      for (let revision = initial + 1; revision <= current; revision++) {
        const changedAt = revisions.get(revision);
        if (!changedAt) return finish("NEEDS_REVIEW", "ACTIVATION_HISTORY_UNCERTAIN");
        if (changedAt <= e.opensAt) return finish("NEEDS_REVIEW", "ACTIVATION_CHANGED_BEFORE_SERVICE");
      }
    }
    // Once opening was evidenced, a later disable/cancellation/outage doesn't
    // erase the accrued obligation. No Stripe call happens in this transaction.
    const result = await tx.pinAIReservationFee.createMany({ skipDuplicates: true, data: [{ reservationId,
      organizationId: e.organizationId, propertyId: e.propertyId, amountCents: 100, currency: "USD",
      termsVersion: e.termsVersion, acceptedBy: e.acceptedBy, acceptedAt: e.acceptedAt,
      serviceStartedAt: e.opensAt, recordedAt: now, billingStatus: "PENDING_CONNECT",
      stripeConnectedAccountId: e.stripeConnectedAccountId,
    }] });
    await finish("ACCRUED", null);
    return result.count === 1 ? "RECORDED" : "ALREADY_RECORDED";
  }, { isolationLevel: "Serializable" });
}
