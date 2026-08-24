import {
  GuestJourneyCoordinationIntentStatus,
  PrismaClient,
} from "@prisma/client";

import { upsertOperationalIssue } from "../apms/operational-intelligence.service";

const ISSUE_CODE = "GUEST_JOURNEY_FINANCIAL_OWNER_EXHAUSTED";

export type FinancialOwnerMissionControlResult = {
  action: "CREATED" | "UPDATED" | "RESOLVED" | "UNCHANGED" | "NOT_REQUIRED";
  operationalIssueWrites: number;
  externalSideEffects: 0;
};

export async function syncGuestJourneyFinancialOwnerMissionControl(
  prisma: PrismaClient,
  intentId: string,
  expectedScope: { organizationId: string; propertyId: string },
  dependencies: { upsert: typeof upsertOperationalIssue } = {
    upsert: upsertOperationalIssue,
  }
): Promise<FinancialOwnerMissionControlResult> {
  const intent = await prisma.guestJourneyCoordinationIntent.findUnique({
    where: { id: intentId },
    select: {
      id: true,
      targetEngine: true,
      intentType: true,
      status: true,
      claimCount: true,
      lastError: true,
      updatedAt: true,
      succeededAt: true,
      exhaustedAt: true,
      supersededAt: true,
      reservationId: true,
      reservation: {
        select: {
          reservationNumber: true,
          guestName: true,
          paymentState: true,
          hostPayoutStatus: true,
          propertyId: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });
  if (!intent) throw new Error("FINANCIAL_OWNER_MISSION_CONTROL_INTENT_NOT_FOUND");
  if (
    intent.targetEngine !== "FINANCIAL" ||
    intent.intentType !== "REQUEST_PAYMENT_EVALUATION"
  ) {
    throw new Error("FINANCIAL_OWNER_MISSION_CONTROL_INTENT_UNSUPPORTED");
  }
  if (
    intent.reservation.propertyId !== expectedScope.propertyId ||
    intent.reservation.property.organizationId !== expectedScope.organizationId
  ) {
    throw new Error("FINANCIAL_OWNER_MISSION_CONTROL_SCOPE_MISMATCH");
  }

  const operationalKey = `GUEST_JOURNEY_FINANCIAL_OWNER_ESCALATION:${intent.id}`;
  const existing = await prisma.operationalIssue.findUnique({
    where: { operationalKey },
    select: {
      workflowState: true,
      lastSignalAt: true,
      firstDetectedAt: true,
    },
  });

  if (intent.status !== GuestJourneyCoordinationIntentStatus.EXHAUSTED) {
    if (!existing || existing.workflowState === "RESOLVED") {
      return { action: "NOT_REQUIRED", operationalIssueWrites: 0, externalSideEffects: 0 };
    }
    const occurredAt = intent.succeededAt ?? intent.supersededAt ?? intent.updatedAt;
    await dependencies.upsert(prisma, {
      operationalKey,
      issueCode: ISSUE_CODE,
      title: "Guest payment evaluation recovered",
      issue: "The durable FINANCIAL intent no longer requires developer intervention.",
      operationalImpact: "The guest journey payment blocker recovered or became obsolete.",
      recommendedAction: null,
      nextAutomaticStep: null,
      engine: "GUEST_JOURNEY",
      severity: "INFO",
      workflowState: "RESOLVED",
      visibility: "DEVELOPER",
      responsibleActor: "PIN_GO",
      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode: null,
      organizationId: expectedScope.organizationId,
      propertyId: expectedScope.propertyId,
      reservationId: intent.reservationId,
      reservationNumber: intent.reservation.reservationNumber,
      guestName: intent.reservation.guestName,
      sourceType: "ENGINE_EVENT",
      firstDetectedAt: existing.firstDetectedAt,
      lastSignalAt: intent.updatedAt,
      resolvedAt: occurredAt,
      resolutionCode: "FINANCIAL_OWNER_RECOVERY_CLEARED",
      resolutionSummary: "The fenced FINANCIAL payment evaluation recovered or became obsolete.",
      resolutionType: intent.status === GuestJourneyCoordinationIntentStatus.SUPERSEDED
        ? "SUPERSEDED"
        : "AUTOMATIC",
      resolvedBy: "PIN_GO",
      actionTarget: "PAYMENT",
      metadata: {
        intentId: intent.id,
        intentType: intent.intentType,
        status: intent.status,
        claimCount: intent.claimCount,
        paymentState: intent.reservation.paymentState,
        hostPayoutStatus: intent.reservation.hostPayoutStatus,
      },
      transitionCode: "GUEST_JOURNEY_FINANCIAL_OWNER_ESCALATION_RESOLVED",
      transitionSummary: "Pin&Go cleared the internal FINANCIAL escalation.",
      transitionedBy: "PIN_GO",
      occurredAt,
    });
    return { action: "RESOLVED", operationalIssueWrites: 1, externalSideEffects: 0 };
  }

  if (
    existing?.workflowState === "ACTION_REQUIRED" &&
    existing.lastSignalAt.getTime() >= intent.updatedAt.getTime()
  ) {
    return { action: "UNCHANGED", operationalIssueWrites: 0, externalSideEffects: 0 };
  }

  const occurredAt = intent.exhaustedAt ?? intent.updatedAt;
  await dependencies.upsert(prisma, {
    operationalKey,
    issueCode: ISSUE_CODE,
    title: "Guest payment evaluation requires review",
    issue: "The fenced FINANCIAL owner found payment evidence that Pin&Go should not repair automatically.",
    operationalImpact: "Guest Journey cannot safely treat the payment blocker as resolved without reviewing persisted financial evidence.",
    recommendedAction: "Review the reservation payment state, Stripe checkout/payment-intent references, and host payout evidence before rearming or superseding this intent.",
    nextAutomaticStep: null,
    engine: "GUEST_JOURNEY",
    severity: "CRITICAL",
    workflowState: "ACTION_REQUIRED",
    visibility: "DEVELOPER",
    responsibleActor: "SYSTEM",
    actionRequired: true,
    canAutoResolve: false,
    autoResolveStatus: "NOT_SUPPORTED",
    autoResolveActionCode: null,
    organizationId: expectedScope.organizationId,
    propertyId: expectedScope.propertyId,
    reservationId: intent.reservationId,
    reservationNumber: intent.reservation.reservationNumber,
    guestName: intent.reservation.guestName,
    sourceType: "ENGINE_EVENT",
    firstDetectedAt: existing?.firstDetectedAt ?? occurredAt,
    lastSignalAt: intent.updatedAt,
    resolvedAt: null,
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
    actionTarget: "PAYMENT",
    metadata: {
      intentId: intent.id,
      intentType: intent.intentType,
      status: intent.status,
      claimCount: intent.claimCount,
      errorCode: intent.lastError,
      paymentState: intent.reservation.paymentState,
      hostPayoutStatus: intent.reservation.hostPayoutStatus,
    },
    transitionCode: "GUEST_JOURNEY_FINANCIAL_OWNER_RETRY_BUDGET_EXHAUSTED",
    transitionSummary: "The FINANCIAL owner fenced unsafe payment evidence and escalated.",
    transitionedBy: "PIN_GO",
    occurredAt,
  });
  return {
    action: existing ? "UPDATED" : "CREATED",
    operationalIssueWrites: 1,
    externalSideEffects: 0,
  };
}
