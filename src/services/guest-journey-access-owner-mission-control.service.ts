import {
  GuestJourneyCoordinationIntentStatus,
  PrismaClient,
} from "@prisma/client";

import { upsertOperationalIssue } from "../apms/operational-intelligence.service";
import {
  guestAccessE15NextAutomaticStep,
  isGuestAccessE15AutoResolvableOwnerExhaustion,
} from "./guest-access-exit-closure-a.policy";

const ISSUE_CODE = "GUEST_JOURNEY_ACCESS_OWNER_EXHAUSTED";

export type AccessOwnerMissionControlResult = {
  action: "CREATED" | "UPDATED" | "RESOLVED" | "UNCHANGED" | "NOT_REQUIRED";
  operationalIssueWrites: number;
  externalSideEffects: 0;
};

export async function syncGuestJourneyAccessOwnerMissionControl(
  prisma: PrismaClient,
  intentId: string,
  expectedScope: {
    organizationId: string;
    propertyId: string;
    e15Enabled?: boolean;
  },
  dependencies: { upsert: typeof upsertOperationalIssue } = {
    upsert: upsertOperationalIssue,
  }
): Promise<AccessOwnerMissionControlResult> {
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
          propertyId: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });
  if (!intent) throw new Error("ACCESS_OWNER_MISSION_CONTROL_INTENT_NOT_FOUND");
  if (
    intent.targetEngine !== "ACCESS" ||
    ![
      "REQUEST_ACCESS_PROVISIONING",
      "REQUEST_ACCESS_REVOCATION_CHECK",
    ].includes(intent.intentType)
  ) {
    throw new Error("ACCESS_OWNER_MISSION_CONTROL_INTENT_UNSUPPORTED");
  }
  if (
    intent.reservation.propertyId !== expectedScope.propertyId ||
    intent.reservation.property.organizationId !== expectedScope.organizationId
  ) {
    throw new Error("ACCESS_OWNER_MISSION_CONTROL_SCOPE_MISMATCH");
  }

  const operationalKey = `GUEST_JOURNEY_ACCESS_OWNER_ESCALATION:${intent.id}`;
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
      title: "Guest access owner escalation resolved",
      issue: "The durable ACCESS intent no longer requires developer intervention.",
      operationalImpact: "The access owner reached a terminal non-exhausted state.",
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
      resolutionCode: "ACCESS_OWNER_RECOVERY_CLEARED",
      resolutionSummary: "The fenced ACCESS intent recovered or became obsolete.",
      resolutionType: intent.status === GuestJourneyCoordinationIntentStatus.SUPERSEDED
        ? "SUPERSEDED"
        : "AUTOMATIC",
      resolvedBy: "PIN_GO",
      actionTarget: "ACCESS",
      metadata: {
        intentId: intent.id,
        intentType: intent.intentType,
        status: intent.status,
        claimCount: intent.claimCount,
      },
      transitionCode: "GUEST_JOURNEY_ACCESS_OWNER_ESCALATION_RESOLVED",
      transitionSummary: "Pin&Go cleared the internal ACCESS escalation.",
      transitionedBy: "PIN_GO",
      occurredAt,
    });
    return { action: "RESOLVED", operationalIssueWrites: 1, externalSideEffects: 0 };
  }

  const e15AutoResolving =
    isGuestAccessE15AutoResolvableOwnerExhaustion({
      e15Enabled: expectedScope.e15Enabled === true,
      intentType: intent.intentType,
      lastError: intent.lastError,
    });
  const desiredWorkflowState = e15AutoResolving
    ? "AUTO_RESOLVING"
    : "ACTION_REQUIRED";

  if (
    existing?.workflowState === desiredWorkflowState &&
    existing.lastSignalAt.getTime() >= intent.updatedAt.getTime()
  ) {
    return { action: "UNCHANGED", operationalIssueWrites: 0, externalSideEffects: 0 };
  }

  const occurredAt = intent.exhaustedAt ?? intent.updatedAt;
  await dependencies.upsert(prisma, {
    operationalKey,
    issueCode: ISSUE_CODE,
    title: e15AutoResolving
      ? "Guest access owner is reconciling an uncertain outcome"
      : "Guest access owner exhausted automatic recovery",
    issue: e15AutoResolving
      ? "The ACCESS owner fenced an uncertain provider outcome and delegated reconciliation to E15."
      : "The fenced ACCESS owner stopped before replaying an uncertain hardware operation.",
    operationalImpact: e15AutoResolving
      ? "Automatic replay remains blocked while Pin&Go verifies provider state."
      : "Guest access provisioning or closure is not completely confirmed.",
    recommendedAction: e15AutoResolving
      ? null
      : "Reconcile the correlated grant and TTLock evidence before rearming this intent.",
    nextAutomaticStep: e15AutoResolving
      ? guestAccessE15NextAutomaticStep(null)
      : null,
    engine: "GUEST_JOURNEY",
    severity: e15AutoResolving ? "WARNING" : "CRITICAL",
    workflowState: desiredWorkflowState,
    visibility: e15AutoResolving ? "SYSTEM" : "DEVELOPER",
    responsibleActor: e15AutoResolving ? "PIN_GO" : "SYSTEM",
    actionRequired: !e15AutoResolving,
    canAutoResolve: e15AutoResolving,
    autoResolveStatus: e15AutoResolving ? "AVAILABLE" : "NOT_SUPPORTED",
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
    actionTarget: "ACCESS",
    metadata: {
      intentId: intent.id,
      intentType: intent.intentType,
      status: intent.status,
      claimCount: intent.claimCount,
      errorCode: intent.lastError,
    },
    transitionCode: e15AutoResolving
      ? "GUEST_JOURNEY_ACCESS_OWNER_DELEGATED_TO_E15"
      : "GUEST_JOURNEY_ACCESS_OWNER_RETRY_BUDGET_EXHAUSTED",
    transitionSummary: e15AutoResolving
      ? "The ACCESS owner delegated fenced ambiguity to E15 reconciliation."
      : "The ACCESS owner fenced uncertain execution and escalated.",
    transitionedBy: "PIN_GO",
    occurredAt,
  });
  return {
    action: existing ? "UPDATED" : "CREATED",
    operationalIssueWrites: 1,
    externalSideEffects: 0,
  };
}
