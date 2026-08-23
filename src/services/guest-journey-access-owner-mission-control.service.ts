import {
  GuestJourneyCoordinationIntentStatus,
  PrismaClient,
} from "@prisma/client";

import { upsertOperationalIssue } from "../apms/operational-intelligence.service";

const ISSUE_CODE = "GUEST_JOURNEY_ACCESS_OWNER_EXHAUSTED";

export type AccessOwnerMissionControlResult = {
  action: "CREATED" | "UPDATED" | "RESOLVED" | "UNCHANGED" | "NOT_REQUIRED";
  operationalIssueWrites: number;
  externalSideEffects: 0;
};

export async function syncGuestJourneyAccessOwnerMissionControl(
  prisma: PrismaClient,
  intentId: string,
  expectedScope: { organizationId: string; propertyId: string },
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
    title: "Guest access owner exhausted automatic recovery",
    issue: "The fenced ACCESS owner stopped before replaying an uncertain hardware operation.",
    operationalImpact: "Guest access provisioning or closure is not completely confirmed.",
    recommendedAction: "Reconcile the correlated grant and TTLock evidence before rearming this intent.",
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
    actionTarget: "ACCESS",
    metadata: {
      intentId: intent.id,
      intentType: intent.intentType,
      status: intent.status,
      claimCount: intent.claimCount,
      errorCode: intent.lastError,
    },
    transitionCode: "GUEST_JOURNEY_ACCESS_OWNER_RETRY_BUDGET_EXHAUSTED",
    transitionSummary: "The ACCESS owner fenced uncertain execution and escalated.",
    transitionedBy: "PIN_GO",
    occurredAt,
  });
  return {
    action: existing ? "UPDATED" : "CREATED",
    operationalIssueWrites: 1,
    externalSideEffects: 0,
  };
}
