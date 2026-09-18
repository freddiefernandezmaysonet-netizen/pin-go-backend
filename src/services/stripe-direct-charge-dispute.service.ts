import type Stripe from "stripe";
import type { PrismaClient } from "@prisma/client";

import { upsertOperationalIssue } from "../apms/operational-intelligence.service";

const ISSUE_CODE = "STRIPE_DIRECT_CHARGE_DISPUTE";

type DisputeDb = Pick<PrismaClient, "reservation" | "operationalIssue">;

type Dependencies = {
  upsert: typeof upsertOperationalIssue;
};

function stripeId(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && "id" in value) {
    const id = String((value as { id?: unknown }).id ?? "").trim();
    return id || null;
  }
  return null;
}

export async function syncStripeDirectChargeDispute(
  prisma: DisputeDb,
  event: Stripe.Event,
  dependencies: Dependencies = { upsert: upsertOperationalIssue }
) {
  if (
    event.type !== "charge.dispute.created" &&
    event.type !== "charge.dispute.updated" &&
    event.type !== "charge.dispute.closed"
  ) {
    return { handled: false, action: "IGNORED" as const };
  }

  const dispute = event.data.object as Stripe.Dispute;
  const disputeId = String(dispute.id ?? "").trim();
  const chargeId = stripeId(dispute.charge);
  const paymentIntentId = stripeId(dispute.payment_intent);

  if (!disputeId || (!chargeId && !paymentIntentId)) {
    return { handled: false, action: "UNRESOLVED" as const };
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      OR: [
        ...(chargeId ? [{ stripeChargeId: chargeId }] : []),
        ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
      ],
    },
    select: {
      id: true,
      reservationNumber: true,
      guestName: true,
      propertyId: true,
      stripeConnectedAccountId: true,
      property: { select: { organizationId: true } },
    },
  });

  if (!reservation) {
    return { handled: false, action: "UNRESOLVED" as const };
  }

  const connectedAccountId = String(
    (event as Stripe.Event & { account?: string }).account ?? ""
  ).trim();

  if (
    connectedAccountId &&
    reservation.stripeConnectedAccountId &&
    connectedAccountId !== reservation.stripeConnectedAccountId
  ) {
    throw new Error("STRIPE_DIRECT_CHARGE_DISPUTE_ACCOUNT_SCOPE_MISMATCH");
  }

  const operationalKey = `STRIPE_DIRECT_CHARGE_DISPUTE:${disputeId}`;
  const existing = await prisma.operationalIssue.findUnique({
    where: { operationalKey },
    select: {
      workflowState: true,
      firstDetectedAt: true,
      lastSignalAt: true,
    },
  });

  const occurredAt = new Date(event.created * 1000);
  const isClosed = event.type === "charge.dispute.closed";

  if (
    !isClosed &&
    existing?.workflowState === "ACTION_REQUIRED" &&
    existing.lastSignalAt.getTime() >= occurredAt.getTime()
  ) {
    return { handled: true, action: "UNCHANGED" as const };
  }

  if (isClosed && existing?.workflowState === "RESOLVED") {
    return { handled: true, action: "UNCHANGED" as const };
  }

  await dependencies.upsert(prisma as PrismaClient, {
    operationalKey,
    issueCode: ISSUE_CODE,
    title: isClosed ? "Stripe payment dispute closed" : "Stripe payment dispute requires review",
    issue: isClosed
      ? "Stripe closed the dispute for this Direct Booking payment."
      : "A guest disputed a Direct Booking payment processed on the host connected Stripe account.",
    operationalImpact: isClosed
      ? "The dispute no longer requires active host review in Pin&Go."
      : "Funds may be withheld or reversed by Stripe while the dispute is reviewed.",
    recommendedAction: isClosed
      ? null
      : "Review the dispute evidence and response deadline in Stripe and respond according to Stripe requirements.",
    nextAutomaticStep: null,
    engine: "PAYMENT",
    severity: isClosed ? "INFO" : "CRITICAL",
    workflowState: isClosed ? "RESOLVED" : "ACTION_REQUIRED",
    visibility: "HOST",
    responsibleActor: isClosed ? "PIN_GO" : "HOST",
    actionRequired: !isClosed,
    canAutoResolve: false,
    autoResolveStatus: "NOT_SUPPORTED",
    autoResolveActionCode: null,
    organizationId: reservation.property.organizationId,
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    reservationNumber: reservation.reservationNumber,
    guestName: reservation.guestName,
    sourceType: "ENGINE_EVENT",
    firstDetectedAt: existing?.firstDetectedAt ?? occurredAt,
    lastSignalAt: occurredAt,
    resolvedAt: isClosed ? occurredAt : null,
    resolutionCode: isClosed ? "STRIPE_DISPUTE_CLOSED" : null,
    resolutionSummary: isClosed ? "Stripe reported the dispute as closed." : null,
    resolutionType: isClosed ? "EXTERNAL" : null,
    resolvedBy: isClosed ? "SYSTEM" : null,
    actionTarget: "PAYMENT",
    metadata: {
      stripeDisputeId: disputeId,
      stripeChargeId: chargeId,
      stripePaymentIntentId: paymentIntentId,
      stripeConnectedAccountId: connectedAccountId || reservation.stripeConnectedAccountId,
      disputeStatus: dispute.status,
      disputeReason: dispute.reason,
      amount: dispute.amount,
      currency: dispute.currency,
      evidenceDueBy: dispute.evidence_details?.due_by ?? null,
      stripeEventId: event.id,
      stripeEventType: event.type,
    },
    transitionCode: isClosed
      ? "STRIPE_DIRECT_CHARGE_DISPUTE_RESOLVED"
      : "STRIPE_DIRECT_CHARGE_DISPUTE_ACTION_REQUIRED",
    transitionSummary: isClosed
      ? "Stripe closed the Direct Charge dispute."
      : "Stripe reported a Direct Charge dispute requiring host review.",
    transitionedBy: "PIN_GO",
    occurredAt,
  });

  return {
    handled: true,
    action: isClosed
      ? ("RESOLVED" as const)
      : existing
        ? ("UPDATED" as const)
        : ("CREATED" as const),
  };
}
