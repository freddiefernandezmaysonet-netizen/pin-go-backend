import {
  GuestJourneyCoordinationIntentStatus,
  PrismaClient,
} from "@prisma/client";

import { upsertOperationalIssue } from "../apms/operational-intelligence.service";

const ISSUE_CODE = "GUEST_JOURNEY_COMMUNICATIONS_EXHAUSTED";

export type CommunicationsMissionControlResult = {
  action: "CREATED" | "UPDATED" | "RESOLVED" | "UNCHANGED" | "NOT_REQUIRED";
  operationalIssueWrites: number;
  externalSideEffects: 0;
};

export async function syncGuestJourneyCommunicationMissionControl(
  prisma: PrismaClient,
  intentId: string,
  expectedScope: {
    organizationId: string;
    propertyId: string;
  },
  dependencies: {
    upsert: typeof upsertOperationalIssue;
  } = { upsert: upsertOperationalIssue }
): Promise<CommunicationsMissionControlResult> {
  const intent = await prisma.guestJourneyCoordinationIntent.findUnique({
    where: { id: intentId },
    select: {
      id: true,
      targetEngine: true,
      intentType: true,
      status: true,
      claimCount: true,
      lastError: true,
      createdAt: true,
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
  if (!intent) throw new Error("COMMUNICATIONS_MISSION_CONTROL_INTENT_NOT_FOUND");
  if (
    intent.targetEngine !== "COMMUNICATIONS" ||
    !["REQUEST_COMMUNICATION", "REQUEST_COMMUNICATION_RETRY"].includes(intent.intentType)
  ) throw new Error("COMMUNICATIONS_MISSION_CONTROL_INTENT_UNSUPPORTED");
  if (
    intent.reservation.propertyId !== expectedScope.propertyId ||
    intent.reservation.property.organizationId !== expectedScope.organizationId
  ) throw new Error("COMMUNICATIONS_MISSION_CONTROL_SCOPE_MISMATCH");

  const operationalKey = `GUEST_JOURNEY_COMMUNICATIONS_ESCALATION:${intent.id}`;
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
      title: "Communication delivery escalation resolved",
      issue: "The durable communication intent no longer requires developer intervention.",
      operationalImpact: "The communication owner reached a terminal non-exhausted state.",
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
      resolutionCode: "COMMUNICATIONS_RECOVERY_CLEARED",
      resolutionSummary: "The fenced communication intent recovered or became obsolete.",
      resolutionType: intent.status === GuestJourneyCoordinationIntentStatus.SUPERSEDED ? "SUPERSEDED" : "AUTOMATIC",
      resolvedBy: "PIN_GO",
      actionTarget: "MESSAGING",
      metadata: {
        intentId: intent.id,
        intentType: intent.intentType,
        status: intent.status,
        claimCount: intent.claimCount,
      },
      transitionCode: "GUEST_JOURNEY_COMMUNICATIONS_ESCALATION_RESOLVED",
      transitionSummary: "Pin&Go cleared the internal communication escalation.",
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
    title: "Communication delivery exhausted its retry budget",
    issue: "The fenced COMMUNICATIONS owner exhausted automatic recovery.",
    operationalImpact: "Delivery is not confirmed; automatic replay stopped to prevent duplicates or contacting the wrong recipient.",
    recommendedAction: "Review the correlated message and provider evidence before rearming this intent.",
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
    actionTarget: "MESSAGING",
    metadata: {
      intentId: intent.id,
      intentType: intent.intentType,
      status: intent.status,
      claimCount: intent.claimCount,
      errorCode: intent.lastError,
    },
    transitionCode: "GUEST_JOURNEY_COMMUNICATIONS_RETRY_BUDGET_EXHAUSTED",
    transitionSummary: "The COMMUNICATIONS owner exhausted its fenced retry budget.",
    transitionedBy: "PIN_GO",
    occurredAt,
  });
  return {
    action: existing ? "UPDATED" : "CREATED",
    operationalIssueWrites: 1,
    externalSideEffects: 0,
  };
}
