import type { PrismaClient } from "@prisma/client";
import { enrollPinAIService, accrueEnrolledPinAIFee } from "./service-enrollment.service.js";
import { recordPinAIReservationFee } from "./reservation-fee.service.js";
import { collectPinAIConnectFee, pinAIConnectBillingAllows, pinAIAllOrganizationsAvailable, type ConnectDebitProvider } from "./fee-connect.service.js";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";
import type { ActivationEnvironment } from "./property-activation.js";
import { INTERNAL_DEMO_SOURCE, INTERNAL_DEMO_PROVIDER } from "../services/internal-demo-scope.js";

export async function runPinAIConnectBillingCycle(db: PrismaClient, provider: ConnectDebitProvider,
  env: ActivationEnvironment, now = new Date()) {
  const organizations = (env.PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS ?? "").split(",").map(s => s.trim())
    .filter(s => s && pinAIConnectBillingAllows(env, s));
  let recorded = 0, attempted = 0, failures = 0, enrolled = 0;
  const global = pinAIAllOrganizationsAvailable(env) && env.PIN_AI_CONNECT_DEBIT_ENABLED === "true";
  if (!global && !organizations.length) return { recorded, attempted, failures, enrolled };
  const organizationScope = global ? {} : { organizationId: { in: organizations } };
  if (env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED === "true" && env.PIN_AI_PROPERTY_ACTIVATION_ENABLED === "true") {
    const upcoming = await db.reservation.findMany({ where: {
      status: "ACTIVE", checkIn: { gt: new Date(now.getTime() + 86400000) },
      pinAIReservationFee: null, pinAIServiceEnrollment: null,
      AND: [{ OR: [{ source: null }, { source: { not: INTERNAL_DEMO_SOURCE } }] },
        { OR: [{ externalProvider: null }, { externalProvider: { not: INTERNAL_DEMO_PROVIDER } }] }],
      property: { ...organizationScope, status: "ACTIVE", isTestProperty: false,
        pinAIEnabled: true, pinAIRevision: { gt: 0 },
        organization: { pinAIEnabled: true, pinAIRevision: { gt: 0 }, stripeConnectAccountId: { not: null } },
        pinAITermsVersion: PIN_AI_BILLING_TERMS.version, pinAITermsAcceptedAt: { lte: now },
        pinAITermsAcceptedBy: { not: null } },
    }, select: { id: true, propertyId: true, property: { select: { organizationId: true } } },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }], take: 20 });
    for (const r of upcoming) {
      try { if (await enrollPinAIService(db, env, { reservationId: r.id, propertyId: r.propertyId,
        organizationId: r.property.organizationId }, now) === "ENROLLED") enrolled++; }
      catch { failures++; }
    }
    const scheduled = await db.pinAIServiceEnrollment.findMany({ where: { ...organizationScope,
      status: "SCHEDULED", opensAt: { lte: now } }, orderBy: [{ opensAt: "asc" }, { reservationId: "asc" }], take: 20 });
    for (const e of scheduled) {
      try { if (await accrueEnrolledPinAIFee(db, env, e.reservationId, now) === "RECORDED") recorded++; }
      catch { failures++; }
    }
    const due = await db.reservation.findMany({ where: {
      status: "ACTIVE", checkIn: { lte: new Date(now.getTime() + 86400000) },
      checkOut: { gt: new Date(now.getTime() - 86400000) }, pinAIReservationFee: null,
      AND: [{ OR: [{ source: null }, { source: { not: INTERNAL_DEMO_SOURCE } }] },
        { OR: [{ externalProvider: null }, { externalProvider: { not: INTERNAL_DEMO_PROVIDER } }] }],
      property: { ...organizationScope, status: "ACTIVE", isTestProperty: false,
        pinAIEnabled: true, organization: { pinAIEnabled: true, pinAIRevision: { gt: 0 }, stripeConnectAccountId: { not: null } },
        pinAITermsVersion: PIN_AI_BILLING_TERMS.version, pinAITermsAcceptedAt: { lte: now },
        pinAITermsAcceptedBy: { not: null } },
    }, select: { id: true, propertyId: true, property: { select: { organizationId: true } } },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }], take: 20 });
    for (const r of due) {
      try { if (await recordPinAIReservationFee(db, env, { reservationId: r.id, propertyId: r.propertyId,
        organizationId: r.property.organizationId }, now) === "RECORDED") recorded++; }
      catch { failures++; }
    }
  }
  // Already accrued fees remain payable after property disable/cancellation.
  const fees = await db.pinAIReservationFee.findMany({ where: { ...organizationScope,
    serviceStartedAt: { lte: now }, termsVersion: PIN_AI_BILLING_TERMS.version,
    OR: [{ billingStatus: { in: ["PENDING_CONNECT", "PENDING_BALANCE"] } },
      { billingStatus: "NEEDS_REVIEW", lastError: "CONNECT_REPLAY_WINDOW_EXPIRED" }],
    AND: [{ OR: [{ exportNextAttemptAt: null }, { exportNextAttemptAt: { lte: now } }] },
      { OR: [{ exportLeaseUntil: null }, { exportLeaseUntil: { lte: now } }] }],
  }, orderBy: [{ exportNextAttemptAt: "asc" }, { recordedAt: "asc" }, { reservationId: "asc" }], take: 5 });
  for (const fee of fees) {
    try { await collectPinAIConnectFee(db, provider, env, fee.reservationId, now); attempted++; }
    catch { failures++; }
  }
  return { recorded, attempted, failures, enrolled };
}
