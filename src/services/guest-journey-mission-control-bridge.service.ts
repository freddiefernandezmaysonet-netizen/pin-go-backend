import {
  GuestJourneyCoordinationIntentStatus,
  PrismaClient,
} from "@prisma/client";

import {
  ApmsOperationalReopenSourceNotResolvedError,
  reopenOperationalIssue,
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";
import type {
  OperationalAutoResolveStatus,
  OperationalResolutionType,
  OperationalWorkflowState,
} from "../apms/operational-intelligence-types";
import type {
  UpsertOperationalIssueInput,
} from "../apms/operational-intelligence.service";
import {
  GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_VERSION,
  GUEST_JOURNEY_MISSION_CONTROL_OPERATIONAL_ISSUE_CODE,
} from "./guest-journey-contract";

export type GuestJourneyMissionControlIntent = {
  id: string;
  reservationId: string;
  status:
    GuestJourneyCoordinationIntentStatus;
  targetEngine: string;
  intentType: string;
  reasonCode: string;
  expectedOutcomeCode: string;
  claimCount: number;
  nextActionAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  succeededAt: Date | null;
  exhaustedAt: Date | null;
  supersededAt: Date | null;
  reservation: {
    reservationNumber: string | null;
    guestName: string | null;
    propertyId: string;
    property: {
      organizationId: string;
    };
  };
  attempts: Array<{
    outcome: string;
    errorCode: string | null;
    completedAt: Date | null;
  }>;
};

export type GuestJourneyMissionControlProjection = {
  lifecycle:
    UpsertOperationalIssueInput;
  escalation:
    UpsertOperationalIssueInput | null;
};

export type GuestJourneyMissionControlSyncAction =
  | "CREATED"
  | "UPDATED"
  | "REOPENED"
  | "UNCHANGED"
  | "NOT_REQUIRED";

export type GuestJourneyMissionControlSyncResult = {
  lifecycle:
    GuestJourneyMissionControlSyncAction;
  escalation:
    GuestJourneyMissionControlSyncAction;
  operationalIssueWrites: number;
  externalSideEffects: 0;
};

type BridgeDependencies = {
  upsert:
    typeof upsertOperationalIssue;
  reopen:
    typeof reopenOperationalIssue;
};

const DEFAULT_DEPENDENCIES:
  BridgeDependencies = {
    upsert: upsertOperationalIssue,
    reopen: reopenOperationalIssue,
  };

const ACTIVE_STATUSES = new Set<
  GuestJourneyCoordinationIntentStatus
>([
  GuestJourneyCoordinationIntentStatus.PENDING,
  GuestJourneyCoordinationIntentStatus.CLAIMED,
  GuestJourneyCoordinationIntentStatus.RETRYABLE,
  GuestJourneyCoordinationIntentStatus.WAITING_FOR_EVIDENCE,
]);

function requireSupportedIntent(
  intent:
    GuestJourneyMissionControlIntent
): void {
  if (
    intent.targetEngine !== "ACCESS" ||
    intent.intentType !==
      "REQUEST_ACCESS_EVALUATION"
  ) {
    throw new Error(
      "GUEST_JOURNEY_MISSION_CONTROL_INTENT_UNSUPPORTED"
    );
  }
}

function normalizeErrorCode(
  intent:
    GuestJourneyMissionControlIntent
): string | null {
  const source =
    intent.attempts[0]?.errorCode ??
    intent.lastError;

  if (!source) return null;

  const code = source
    .split(":", 1)[0]
    .trim()
    .replace(/[^A-Z0-9_]/gi, "_")
    .toUpperCase()
    .slice(0, 120);

  return code || "OWNER_RUNTIME_ERROR";
}

function getOccurrenceTime(
  intent:
    GuestJourneyMissionControlIntent
): Date {
  if (
    intent.status ===
    GuestJourneyCoordinationIntentStatus.SUCCEEDED
  ) {
    return intent.succeededAt ?? intent.updatedAt;
  }

  if (
    intent.status ===
    GuestJourneyCoordinationIntentStatus.EXHAUSTED
  ) {
    return intent.exhaustedAt ?? intent.updatedAt;
  }

  if (
    intent.status ===
    GuestJourneyCoordinationIntentStatus.SUPERSEDED
  ) {
    return intent.supersededAt ?? intent.updatedAt;
  }

  return intent.updatedAt;
}

function describeReservation(
  intent:
    GuestJourneyMissionControlIntent
): string {
  return intent.reservation
    .reservationNumber
    ? `reservation ${intent.reservation.reservationNumber}`
    : "the reservation";
}

function buildLifecycleState(input: {
  intent:
    GuestJourneyMissionControlIntent;
  ownerRuntimeEnabled: boolean;
}): {
  title: string;
  issue: string;
  operationalImpact: string;
  nextAutomaticStep: string | null;
  severity: "INFO" | "WARNING";
  workflowState:
    OperationalWorkflowState;
  responsibleActor:
    "PIN_GO" | "SYSTEM" | "NONE";
  canAutoResolve: boolean;
  autoResolveStatus:
    OperationalAutoResolveStatus;
  resolutionCode: string | null;
  resolutionSummary: string | null;
  resolutionType:
    OperationalResolutionType | null;
  resolvedBy:
    "PIN_GO" | null;
} {
  const reservation =
    describeReservation(input.intent);
  const status = input.intent.status;

  if (
    status ===
    GuestJourneyCoordinationIntentStatus.SUCCEEDED
  ) {
    return {
      title:
        "Guest access evaluation completed",
      issue:
        `Pin&Go confirmed canonical access eligibility for ${reservation}.`,
      operationalImpact:
        "The Guest Journey may continue to the next Access Engine responsibility.",
      nextAutomaticStep: null,
      severity: "INFO",
      workflowState: "RESOLVED",
      responsibleActor: "PIN_GO",
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      resolutionCode:
        "OWNER_RUNTIME_INTENT_SUCCEEDED",
      resolutionSummary:
        "Pin&Go verified the expected canonical access outcome.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",
    };
  }

  if (
    status ===
    GuestJourneyCoordinationIntentStatus.SUPERSEDED
  ) {
    return {
      title:
        "Guest access evaluation superseded",
      issue:
        `Pin&Go replaced an obsolete access evaluation for ${reservation} after canonical evidence changed.`,
      operationalImpact:
        "Obsolete work will not be executed against current reservation evidence.",
      nextAutomaticStep: null,
      severity: "INFO",
      workflowState: "RESOLVED",
      responsibleActor: "PIN_GO",
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      resolutionCode:
        "OWNER_RUNTIME_INTENT_SUPERSEDED",
      resolutionSummary:
        "Pin&Go retired the obsolete intent without executing it.",
      resolutionType: "SUPERSEDED",
      resolvedBy: "PIN_GO",
    };
  }

  if (
    status ===
    GuestJourneyCoordinationIntentStatus.EXHAUSTED
  ) {
    return {
      title:
        "Guest access evaluation is under Pin&Go review",
      issue:
        `Pin&Go could not complete the durable access evaluation for ${reservation} within its retry budget.`,
      operationalImpact:
        "Access eligibility remains protected and no credential action was executed by this workflow.",
      nextAutomaticStep:
        "Pin&Go has escalated the failure for internal technical review.",
      severity: "WARNING",
      workflowState: "WAITING",
      responsibleActor: "PIN_GO",
      canAutoResolve: false,
      autoResolveStatus: "NOT_SUPPORTED",
      resolutionCode: null,
      resolutionSummary: null,
      resolutionType: null,
      resolvedBy: null,
    };
  }

  if (
    status ===
    GuestJourneyCoordinationIntentStatus.WAITING_FOR_EVIDENCE
  ) {
    return {
      title:
        "Guest access evaluation is waiting for evidence",
      issue:
        `Pin&Go is waiting for canonical reservation evidence before completing access eligibility for ${reservation}.`,
      operationalImpact:
        "Access remains blocked until every required condition is persistently verified.",
      nextAutomaticStep:
        input.ownerRuntimeEnabled
          ? "Pin&Go will reevaluate the intent when canonical evidence changes."
          : "The canary owner runtime remains paused until explicitly authorized.",
      severity: "INFO",
      workflowState: "WAITING",
      responsibleActor:
        input.ownerRuntimeEnabled
          ? "PIN_GO"
          : "NONE",
      canAutoResolve:
        input.ownerRuntimeEnabled,
      autoResolveStatus:
        input.ownerRuntimeEnabled
          ? "AVAILABLE"
          : "NOT_SUPPORTED",
      resolutionCode: null,
      resolutionSummary: null,
      resolutionType: null,
      resolvedBy: null,
    };
  }

  if (!input.ownerRuntimeEnabled) {
    return {
      title:
        "Guest access evaluation is queued",
      issue:
        `A durable access evaluation is queued for ${reservation}, but its canary owner runtime is paused.`,
      operationalImpact:
        "The intent remains durable and no credential action has been executed.",
      nextAutomaticStep:
        "The canary owner runtime remains paused until explicitly authorized.",
      severity: "INFO",
      workflowState: "WAITING",
      responsibleActor: "NONE",
      canAutoResolve: false,
      autoResolveStatus: "NOT_SUPPORTED",
      resolutionCode: null,
      resolutionSummary: null,
      resolutionType: null,
      resolvedBy: null,
    };
  }

  const running =
    status ===
    GuestJourneyCoordinationIntentStatus.CLAIMED;

  return {
    title:
      "Pin&Go is evaluating guest access",
    issue:
      `Pin&Go is ${
        running ? "executing" : "preparing"
      } a fenced access evaluation for ${reservation}.`,
    operationalImpact:
      "Pin&Go is verifying eligibility without provisioning, revoking, or communicating credentials.",
    nextAutomaticStep:
      running
        ? "Pin&Go will verify canonical outcome evidence before completing the intent."
        : "Pin&Go will claim the durable intent when its retry window is due.",
    severity: "INFO",
    workflowState: "AUTO_RESOLVING",
    responsibleActor: "PIN_GO",
    canAutoResolve: true,
    autoResolveStatus:
      running ? "RUNNING" : "AVAILABLE",
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
  };
}

function buildSharedMetadata(input: {
  intent:
    GuestJourneyMissionControlIntent;
  ownerRuntimeEnabled: boolean;
}): Record<string, unknown> {
  return {
    bridgeVersion:
      GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_VERSION,
    ownerRuntimeStatus:
      input.intent.status,
    ownerRuntimeEnabled:
      input.ownerRuntimeEnabled,
    targetEngine:
      input.intent.targetEngine,
    intentType:
      input.intent.intentType,
    reasonCode:
      input.intent.reasonCode,
    expectedOutcomeCode:
      input.intent.expectedOutcomeCode,
    claimCount:
      input.intent.claimCount,
    nextActionAt:
      input.intent.nextActionAt
        ?.toISOString() ?? null,
    latestAttemptOutcome:
      input.intent.attempts[0]
        ?.outcome ?? null,
    errorCode:
      normalizeErrorCode(input.intent),
  };
}

export function projectGuestJourneyOwnerIntentToMissionControl(
  intent:
    GuestJourneyMissionControlIntent,
  options: {
    ownerRuntimeEnabled: boolean;
  }
): GuestJourneyMissionControlProjection {
  requireSupportedIntent(intent);

  const state = buildLifecycleState({
    intent,
    ownerRuntimeEnabled:
      options.ownerRuntimeEnabled,
  });
  const occurredAt =
    getOccurrenceTime(intent);
  const metadata = buildSharedMetadata({
    intent,
    ownerRuntimeEnabled:
      options.ownerRuntimeEnabled,
  });
  const organizationId =
    intent.reservation.property
      .organizationId;
  const propertyId =
    intent.reservation.propertyId;

  const lifecycle:
    UpsertOperationalIssueInput = {
    operationalKey:
      `GUEST_JOURNEY_OWNER_RUNTIME:${intent.id}`,
    issueCode:
      GUEST_JOURNEY_MISSION_CONTROL_OPERATIONAL_ISSUE_CODE,
    title: state.title,
    issue: state.issue,
    operationalImpact:
      state.operationalImpact,
    recommendedAction: null,
    nextAutomaticStep:
      state.nextAutomaticStep,
    engine: "GUEST_JOURNEY",
    severity: state.severity,
    workflowState:
      state.workflowState,
    visibility: "HOST",
    responsibleActor:
      state.responsibleActor,
    actionRequired: false,
    canAutoResolve:
      state.canAutoResolve,
    autoResolveStatus:
      state.autoResolveStatus,
    autoResolveActionCode: null,
    organizationId,
    propertyId,
    reservationId:
      intent.reservationId,
    reservationNumber:
      intent.reservation
        .reservationNumber,
    guestName:
      intent.reservation.guestName,
    sourceType: "ENGINE_EVENT",
    firstDetectedAt:
      intent.createdAt,
    lastSignalAt:
      intent.updatedAt,
    resolvedAt:
      state.workflowState === "RESOLVED"
        ? occurredAt
        : null,
    resolutionCode:
      state.resolutionCode,
    resolutionSummary:
      state.resolutionSummary,
    resolutionType:
      state.resolutionType,
    resolvedBy:
      state.resolvedBy,
    actionTarget: "ACCESS",
    metadata,
    transitionCode:
      `GUEST_JOURNEY_OWNER_RUNTIME_${intent.status}`,
    transitionSummary:
      `Guest Journey owner runtime projected durable intent status ${intent.status}.`,
    transitionedBy: "PIN_GO",
    occurredAt,
  };

  const escalation =
    intent.status ===
    GuestJourneyCoordinationIntentStatus.EXHAUSTED
      ? ({
          operationalKey:
            `GUEST_JOURNEY_OWNER_RUNTIME_ESCALATION:${intent.id}`,
          issueCode:
            "GUEST_JOURNEY_OWNER_RUNTIME_EXHAUSTED",
          title:
            "Guest access evaluation exhausted its retry budget",
          issue:
            "The fenced ACCESS evaluation owner runtime exhausted its durable retry budget.",
          operationalImpact:
            "Canonical access eligibility was not completed and no external credential side effect was executed.",
          recommendedAction:
            "Review the durable attempt evidence and underlying error before rearming this canary intent.",
          nextAutomaticStep: null,
          engine: "GUEST_JOURNEY",
          severity: "CRITICAL",
          workflowState:
            "ACTION_REQUIRED",
          visibility: "DEVELOPER",
          responsibleActor:
            "SYSTEM",
          actionRequired: true,
          canAutoResolve: false,
          autoResolveStatus:
            "NOT_SUPPORTED",
          autoResolveActionCode: null,
          organizationId,
          propertyId,
          reservationId:
            intent.reservationId,
          reservationNumber:
            intent.reservation
              .reservationNumber,
          guestName:
            intent.reservation.guestName,
          sourceType: "ENGINE_EVENT",
          firstDetectedAt:
            intent.exhaustedAt ??
            intent.updatedAt,
          lastSignalAt:
            intent.updatedAt,
          resolvedAt: null,
          resolutionCode: null,
          resolutionSummary: null,
          resolutionType: null,
          resolvedBy: null,
          actionTarget: "ACCESS",
          metadata,
          transitionCode:
            "GUEST_JOURNEY_OWNER_RUNTIME_RETRY_BUDGET_EXHAUSTED",
          transitionSummary:
            "The ACCESS evaluation owner runtime exhausted its fenced retry budget.",
          transitionedBy:
            "PIN_GO",
          occurredAt,
        } satisfies UpsertOperationalIssueInput)
      : null;

  return {
    lifecycle,
    escalation,
  };
}

function isResolved(
  workflowState: string
): boolean {
  return workflowState === "RESOLVED";
}

async function persistProjection(input: {
  prisma: PrismaClient;
  projection:
    UpsertOperationalIssueInput;
  dependencies:
    BridgeDependencies;
}): Promise<{
  action:
    GuestJourneyMissionControlSyncAction;
  writes: number;
}> {
  const current =
    await input.prisma.operationalIssue
      .findUnique({
        where: {
          operationalKey:
            input.projection
              .operationalKey,
        },
        select: {
          workflowState: true,
          issueCode: true,
          lastSignalAt: true,
        },
      });

  const projectedSignalAt =
    input.projection.lastSignalAt ??
    input.projection.occurredAt ??
    new Date();

  if (
    current &&
    current.workflowState ===
      input.projection.workflowState &&
    current.issueCode ===
      input.projection.issueCode &&
    current.lastSignalAt.getTime() >=
      projectedSignalAt.getTime()
  ) {
    return {
      action: "UNCHANGED",
      writes: 0,
    };
  }

  let reopened = false;

  if (
    current &&
    isResolved(current.workflowState) &&
    !isResolved(
      input.projection.workflowState
    )
  ) {
    try {
      await input.dependencies.reopen(
        input.prisma,
        {
          operationalKey:
            input.projection
              .operationalKey,
          workflowState:
            input.projection
              .workflowState as Exclude<
              OperationalWorkflowState,
              "RESOLVED"
            >,
          severity:
            input.projection.severity,
          responsibleActor:
            input.projection
              .responsibleActor,
          actionRequired:
            input.projection
              .actionRequired,
          recommendedAction:
            input.projection
              .recommendedAction,
          nextAutomaticStep:
            input.projection
              .nextAutomaticStep,
          canAutoResolve:
            input.projection
              .canAutoResolve,
          autoResolveStatus:
            input.projection
              .autoResolveStatus,
          autoResolveActionCode:
            input.projection
              .autoResolveActionCode,
          reopenCode:
            "GUEST_JOURNEY_OWNER_RUNTIME_INTENT_REACTIVATED",
          reopenSummary:
            "A previously terminal owner-runtime intent became active again.",
          reopenedBy: "PIN_GO",
          sourceType:
            input.projection
              .sourceType,
          occurredAt:
            input.projection
              .occurredAt,
          metadata:
            input.projection.metadata,
        }
      );
      reopened = true;
    } catch (error) {
      if (
        !(error instanceof
          ApmsOperationalReopenSourceNotResolvedError)
      ) {
        throw error;
      }
    }
  }

  await input.dependencies.upsert(
    input.prisma,
    input.projection
  );

  return {
    action: reopened
      ? "REOPENED"
      : current
        ? "UPDATED"
        : "CREATED",
    writes: reopened ? 2 : 1,
  };
}

function buildEscalationResolution(input: {
  intent:
    GuestJourneyMissionControlIntent;
  existing: {
    firstDetectedAt: Date;
  };
}): UpsertOperationalIssueInput {
  const resolutionType:
    OperationalResolutionType =
    input.intent.status ===
    GuestJourneyCoordinationIntentStatus.SUPERSEDED
      ? "SUPERSEDED"
      : "AUTOMATIC";

  return {
    operationalKey:
      `GUEST_JOURNEY_OWNER_RUNTIME_ESCALATION:${input.intent.id}`,
    issueCode:
      "GUEST_JOURNEY_OWNER_RUNTIME_EXHAUSTED",
    title:
      "Guest access evaluation escalation resolved",
    issue:
      "The internal owner-runtime escalation is no longer active.",
    operationalImpact:
      "No developer intervention remains pending for this durable intent.",
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
    organizationId:
      input.intent.reservation
        .property.organizationId,
    propertyId:
      input.intent.reservation
        .propertyId,
    reservationId:
      input.intent.reservationId,
    reservationNumber:
      input.intent.reservation
        .reservationNumber,
    guestName:
      input.intent.reservation.guestName,
    sourceType: "ENGINE_EVENT",
    firstDetectedAt:
      input.existing.firstDetectedAt,
    lastSignalAt:
      input.intent.updatedAt,
    resolvedAt:
      getOccurrenceTime(input.intent),
    resolutionCode:
      "OWNER_RUNTIME_ESCALATION_CLEARED",
    resolutionSummary:
      "The durable owner-runtime intent reached a terminal non-exhausted state.",
    resolutionType,
    resolvedBy: "PIN_GO",
    actionTarget: "ACCESS",
    metadata: buildSharedMetadata({
      intent: input.intent,
      ownerRuntimeEnabled: false,
    }),
    transitionCode:
      "GUEST_JOURNEY_OWNER_RUNTIME_ESCALATION_RESOLVED",
    transitionSummary:
      "Pin&Go cleared the internal owner-runtime escalation.",
    transitionedBy: "PIN_GO",
    occurredAt:
      getOccurrenceTime(input.intent),
  };
}

export async function syncGuestJourneyOwnerIntentMissionControl(
  prisma: PrismaClient,
  intent:
    GuestJourneyMissionControlIntent,
  options: {
    ownerRuntimeEnabled: boolean;
    expectedScope: {
      organizationId: string;
      propertyId: string;
    };
  },
  dependencies:
    BridgeDependencies =
      DEFAULT_DEPENDENCIES
): Promise<GuestJourneyMissionControlSyncResult> {
  if (
    intent.reservation.propertyId !==
      options.expectedScope.propertyId ||
    intent.reservation.property
      .organizationId !==
      options.expectedScope.organizationId
  ) {
    throw new Error(
      "GUEST_JOURNEY_MISSION_CONTROL_SCOPE_MISMATCH"
    );
  }

  const scopeCount =
    await prisma
      .guestJourneyCoordinationIntent
      .count({
        where: {
          id: intent.id,
          targetEngine: "ACCESS",
          intentType:
            "REQUEST_ACCESS_EVALUATION",
          reservation: {
            is: {
              propertyId:
                options.expectedScope
                  .propertyId,
              property: {
                is: {
                  organizationId:
                    options.expectedScope
                      .organizationId,
                },
              },
            },
          },
        },
      });

  if (scopeCount !== 1) {
    throw new Error(
      "GUEST_JOURNEY_MISSION_CONTROL_SCOPE_CHANGED"
    );
  }

  const projection =
    projectGuestJourneyOwnerIntentToMissionControl(
      intent,
      options
    );
  const lifecycle =
    await persistProjection({
      prisma,
      projection:
        projection.lifecycle,
      dependencies,
    });

  let escalation:
    GuestJourneyMissionControlSyncAction =
    "NOT_REQUIRED";
  let escalationWrites = 0;

  if (projection.escalation) {
    const result =
      await persistProjection({
        prisma,
        projection:
          projection.escalation,
        dependencies,
      });
    escalation = result.action;
    escalationWrites = result.writes;
  } else {
    const operationalKey =
      `GUEST_JOURNEY_OWNER_RUNTIME_ESCALATION:${intent.id}`;
    const existing =
      await prisma.operationalIssue
        .findUnique({
          where: {
            operationalKey,
          },
          select: {
            workflowState: true,
            firstDetectedAt: true,
          },
        });

    if (
      existing &&
      !isResolved(
        existing.workflowState
      )
    ) {
      const result =
        await persistProjection({
          prisma,
          projection:
            buildEscalationResolution({
              intent,
              existing,
            }),
          dependencies,
        });
      escalation = result.action;
      escalationWrites = result.writes;
    } else if (existing) {
      escalation = "UNCHANGED";
    }
  }

  return {
    lifecycle: lifecycle.action,
    escalation,
    operationalIssueWrites:
      lifecycle.writes +
      escalationWrites,
    externalSideEffects: 0,
  };
}

export function isGuestJourneyOwnerRuntimeActiveStatus(
  status:
    GuestJourneyCoordinationIntentStatus
): boolean {
  return ACTIVE_STATUSES.has(status);
}
