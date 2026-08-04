import {
  OperationalActionTarget as PrismaOperationalActionTarget,
  OperationalActor as PrismaOperationalActor,
  OperationalAutoResolveStatus as PrismaOperationalAutoResolveStatus,
  OperationalResolutionType as PrismaOperationalResolutionType,
  OperationalSeverity as PrismaOperationalSeverity,
  OperationalSourceType as PrismaOperationalSourceType,
  OperationalVisibility as PrismaOperationalVisibility,
  OperationalWorkflowState as PrismaOperationalWorkflowState,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import type {
  OperationalActor,
  OperationalResolutionType,
  OperationalSourceType,
  OperationalWorkflowState,
  UpsertOperationalItemInput,
} from "./operational-intelligence-types.js";
import { requireOperationalTransition } from "./operational-transition-policy.js";

export type UpsertOperationalIssueInput =
  UpsertOperationalItemInput & {
    /**
     * Structured reason for recording a lifecycle transition.
     *
     * Examples:
     * CLEANING_CONFIRMATION_DETECTED
     * CLEANING_CONFIRMATION_DECLINED
     * CLEANER_ACCESS_CREATED
     */
    transitionCode: string;

    /**
     * Human-readable explanation of the lifecycle transition.
     */
    transitionSummary: string;

    /**
     * Actor responsible for producing the transition.
     */
    transitionedBy: OperationalActor;

    /**
     * Time when the transition occurred.
     */
    occurredAt?: Date;
  };

export type ResolveOperationalIssuesForReservationInput = {
  reservationId: string;

  resolutionCode: string;
  resolutionSummary: string;

  resolutionType?: OperationalResolutionType;
  resolvedBy: OperationalActor;

  sourceType: OperationalSourceType;
  decisionId?: string | null;
  sourceAuditEntryId?: string | null;

  occurredAt?: Date;
};

function normalizeRequiredText(value: unknown, fieldName: string) {
  const text = String(value ?? "").trim();

  if (!text) {
    throw new Error(
      `Operational Intelligence requires a non-empty ${fieldName}.`
    );
  }

  return text;
}

function normalizeOptionalText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeDate(value: Date | string | null | undefined) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      "Operational Intelligence received an invalid date value."
    );
  }

  return date;
}

function normalizeJsonValue(
  value: Record<string, unknown>
): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function validateOperationalState(input: UpsertOperationalIssueInput) {
  if (
    input.workflowState === "ACTION_REQUIRED" &&
    input.actionRequired !== true
  ) {
    throw new Error(
      "ACTION_REQUIRED operational issues must require human action."
    );
  }

  if (
    input.workflowState !== "ACTION_REQUIRED" &&
    input.actionRequired !== false
  ) {
    throw new Error(
      `${input.workflowState} operational issues cannot require human action.`
    );
  }

  if (
    input.workflowState === "ACTION_REQUIRED" &&
    !normalizeOptionalText(input.recommendedAction)
  ) {
    throw new Error(
      "ACTION_REQUIRED operational issues require a recommendedAction."
    );
  }

  if (
    (input.workflowState === "WAITING" ||
      input.workflowState === "AUTO_RESOLVING") &&
    !normalizeOptionalText(input.nextAutomaticStep)
  ) {
    throw new Error(
      `${input.workflowState} operational issues require a nextAutomaticStep.`
    );
  }

  if (
    input.workflowState === "AUTO_RESOLVING" &&
    input.canAutoResolve !== true
  ) {
    throw new Error(
      "AUTO_RESOLVING operational issues must support auto-resolution."
    );
  }

  if (
    input.canAutoResolve === false &&
    input.autoResolveStatus !== "NOT_SUPPORTED"
  ) {
    throw new Error(
      "Issues without auto-resolution support must use NOT_SUPPORTED."
    );
  }

  if (
    input.canAutoResolve === true &&
    input.autoResolveStatus === "NOT_SUPPORTED"
  ) {
    throw new Error(
      "Auto-resolvable issues cannot use NOT_SUPPORTED."
    );
  }

  if (input.workflowState === "RESOLVED") {
    if (!normalizeOptionalText(input.resolutionCode)) {
      throw new Error(
        "RESOLVED operational issues require a resolutionCode."
      );
    }

    if (!normalizeOptionalText(input.resolutionSummary)) {
      throw new Error(
        "RESOLVED operational issues require a resolutionSummary."
      );
    }

    if (!input.resolutionType) {
      throw new Error(
        "RESOLVED operational issues require a resolutionType."
      );
    }

    if (!input.resolvedBy) {
      throw new Error(
        "RESOLVED operational issues require a resolvedBy actor."
      );
    }
  }
}

function shouldCreateTransition(
  current:
    | {
        workflowState: PrismaOperationalWorkflowState;
        issueCode: string;
      }
    | null,
  nextWorkflowState: OperationalWorkflowState,
  nextIssueCode: string
) {
  if (!current) {
    return true;
  }

  return (
    current.workflowState !== nextWorkflowState ||
    current.issueCode !== nextIssueCode
  );
}

export async function upsertOperationalIssue(
  prisma: PrismaClient,
  input: UpsertOperationalIssueInput
) {
  validateOperationalState(input);

  const operationalKey = normalizeRequiredText(
    input.operationalKey,
    "operationalKey"
  );

  const issueCode = normalizeRequiredText(
    input.issueCode,
    "issueCode"
  );

  const title = normalizeRequiredText(input.title, "title");
  const issue = normalizeRequiredText(input.issue, "issue");
  const engine = normalizeRequiredText(input.engine, "engine");

  const transitionCode = normalizeRequiredText(
    input.transitionCode,
    "transitionCode"
  );

  const transitionSummary = normalizeRequiredText(
    input.transitionSummary,
    "transitionSummary"
  );

  const occurredAt = input.occurredAt ?? new Date();
  const lastSignalAt = input.lastSignalAt ?? occurredAt;
  const requestedFirstDetectedAt =
    input.firstDetectedAt ?? occurredAt;

  const requestedResolvedAt = normalizeDate(input.resolvedAt);

  const effectiveResolvedAt =
    input.workflowState === "RESOLVED"
      ? requestedResolvedAt ?? occurredAt
      : null;

  return prisma.$transaction(async (transaction) => {
    const currentIssue =
      await transaction.operationalIssue.findUnique({
        where: {
          operationalKey,
        },
      });

    requireOperationalTransition(
      currentIssue?.workflowState ?? null,
      input.workflowState
    );

    const createTransition = shouldCreateTransition(
      currentIssue,
      input.workflowState,
      issueCode
    );

    const operationalIssue =
      await transaction.operationalIssue.upsert({
        where: {
          operationalKey,
        },

        create: {
          operationalKey,
          issueCode,

          title,
          issue,
          operationalImpact:
            normalizeOptionalText(input.operationalImpact),
          recommendedAction:
            normalizeOptionalText(input.recommendedAction),
          nextAutomaticStep:
            normalizeOptionalText(input.nextAutomaticStep),

          engine,
          severity:
            input.severity as PrismaOperationalSeverity,
          workflowState:
            input.workflowState as PrismaOperationalWorkflowState,
          visibility:
            input.visibility as PrismaOperationalVisibility,
          responsibleActor:
            input.responsibleActor as PrismaOperationalActor,

          actionRequired: input.actionRequired,
          canAutoResolve: input.canAutoResolve,
          autoResolveStatus:
            input.autoResolveStatus as PrismaOperationalAutoResolveStatus,
          autoResolveActionCode:
            normalizeOptionalText(input.autoResolveActionCode),

          organizationId:
            normalizeOptionalText(input.organizationId),
          propertyId:
            normalizeOptionalText(input.propertyId),
          reservationId:
            normalizeOptionalText(input.reservationId),

          guestName:
            normalizeOptionalText(input.guestName),
          staffMemberId:
            normalizeOptionalText(input.staffMemberId),
          cleanerName:
            normalizeOptionalText(input.cleanerName),

          decisionId:
            normalizeOptionalText(input.decisionId),
          sourceAuditEntryId:
            normalizeOptionalText(input.sourceAuditEntryId),
          sourceType:
            input.sourceType as PrismaOperationalSourceType,

          firstDetectedAt: requestedFirstDetectedAt,
          lastSignalAt,
          resolvedAt: effectiveResolvedAt,

          resolutionCode:
            input.workflowState === "RESOLVED"
              ? normalizeOptionalText(input.resolutionCode)
              : null,
          resolutionSummary:
            input.workflowState === "RESOLVED"
              ? normalizeOptionalText(input.resolutionSummary)
              : null,
          resolutionType:
            input.workflowState === "RESOLVED" &&
            input.resolutionType
              ? (input.resolutionType as PrismaOperationalResolutionType)
              : null,
          resolvedBy:
            input.workflowState === "RESOLVED" &&
            input.resolvedBy
              ? (input.resolvedBy as PrismaOperationalActor)
              : null,

          actionTarget:
            input.actionTarget as PrismaOperationalActionTarget,

          ...(input.metadata !== undefined
            ? { metadata: normalizeJsonValue(input.metadata) }
            : {}),
        },

        update: {
          issueCode,

          title,
          issue,
          operationalImpact:
            normalizeOptionalText(input.operationalImpact),
          recommendedAction:
            normalizeOptionalText(input.recommendedAction),
          nextAutomaticStep:
            normalizeOptionalText(input.nextAutomaticStep),

          engine,
          severity:
            input.severity as PrismaOperationalSeverity,
          workflowState:
            input.workflowState as PrismaOperationalWorkflowState,
          visibility:
            input.visibility as PrismaOperationalVisibility,
          responsibleActor:
            input.responsibleActor as PrismaOperationalActor,

          actionRequired: input.actionRequired,
          canAutoResolve: input.canAutoResolve,
          autoResolveStatus:
            input.autoResolveStatus as PrismaOperationalAutoResolveStatus,
          autoResolveActionCode:
            normalizeOptionalText(input.autoResolveActionCode),

          organizationId:
            normalizeOptionalText(input.organizationId),
          propertyId:
            normalizeOptionalText(input.propertyId),
          reservationId:
            normalizeOptionalText(input.reservationId),

          guestName:
            normalizeOptionalText(input.guestName),
          staffMemberId:
            normalizeOptionalText(input.staffMemberId),
          cleanerName:
            normalizeOptionalText(input.cleanerName),

          decisionId:
            normalizeOptionalText(input.decisionId),
          sourceAuditEntryId:
            normalizeOptionalText(input.sourceAuditEntryId),
          sourceType:
            input.sourceType as PrismaOperationalSourceType,

          lastSignalAt,
          resolvedAt: effectiveResolvedAt,

          resolutionCode:
            input.workflowState === "RESOLVED"
              ? normalizeOptionalText(input.resolutionCode)
              : null,
          resolutionSummary:
            input.workflowState === "RESOLVED"
              ? normalizeOptionalText(input.resolutionSummary)
              : null,
          resolutionType:
            input.workflowState === "RESOLVED" &&
            input.resolutionType
              ? (input.resolutionType as PrismaOperationalResolutionType)
              : null,
          resolvedBy:
            input.workflowState === "RESOLVED" &&
            input.resolvedBy
              ? (input.resolvedBy as PrismaOperationalActor)
              : null,

          actionTarget:
            input.actionTarget as PrismaOperationalActionTarget,

          ...(input.metadata !== undefined
            ? { metadata: normalizeJsonValue(input.metadata) }
            : {}),
        },
      });

    if (createTransition) {
      await transaction.operationalIssueTransition.create({
        data: {
          issueId: operationalIssue.id,
          operationalKey,
          issueCode,

          fromWorkflowState:
            currentIssue?.workflowState ?? null,
          toWorkflowState:
            input.workflowState as PrismaOperationalWorkflowState,

          transitionCode,
          transitionSummary,
          transitionedBy:
            input.transitionedBy as PrismaOperationalActor,

          sourceType:
            input.sourceType as PrismaOperationalSourceType,
          decisionId:
            normalizeOptionalText(input.decisionId),
          sourceAuditEntryId:
            normalizeOptionalText(input.sourceAuditEntryId),

          occurredAt,
          ...(input.metadata !== undefined
            ? { metadata: normalizeJsonValue(input.metadata) }
            : {}),
        },
      });
    }

    return operationalIssue;
  });
}
export async function resolveOperationalIssuesForReservation(
  prisma: PrismaClient,
  input: ResolveOperationalIssuesForReservationInput
) {
  const reservationId = normalizeRequiredText(
    input.reservationId,
    "reservationId"
  );

  const resolutionCode = normalizeRequiredText(
    input.resolutionCode,
    "resolutionCode"
  );

  const resolutionSummary = normalizeRequiredText(
    input.resolutionSummary,
    "resolutionSummary"
  );

  const occurredAt = input.occurredAt ?? new Date();

  const resolutionType =
    input.resolutionType ?? "SUPERSEDED";

  return prisma.$transaction(async (transaction) => {
    const activeIssues =
      await transaction.operationalIssue.findMany({
        where: {
          reservationId,
          workflowState: {
            not: PrismaOperationalWorkflowState.RESOLVED,
          },
        },
        orderBy: {
          firstDetectedAt: "asc",
        },
      });

    const resolvedIssueIds: string[] = [];

    for (const activeIssue of activeIssues) {
      const updateResult =
        await transaction.operationalIssue.updateMany({
          where: {
            id: activeIssue.id,
            workflowState: {
              not: PrismaOperationalWorkflowState.RESOLVED,
            },
          },
          data: {
            workflowState:
              PrismaOperationalWorkflowState.RESOLVED,
            severity:
              PrismaOperationalSeverity.INFO,
            responsibleActor:
              PrismaOperationalActor.NONE,

            actionRequired: false,
            autoResolveActionCode: null,

            recommendedAction: null,
            nextAutomaticStep: null,

            lastSignalAt: occurredAt,
            resolvedAt: occurredAt,

            resolutionCode,
            resolutionSummary,
            resolutionType:
              resolutionType as PrismaOperationalResolutionType,
            resolvedBy:
              input.resolvedBy as PrismaOperationalActor,

            decisionId:
              normalizeOptionalText(input.decisionId),
            sourceAuditEntryId:
              normalizeOptionalText(
                input.sourceAuditEntryId
              ),
            sourceType:
              input.sourceType as PrismaOperationalSourceType,
          },
        });

      if (updateResult.count !== 1) {
        continue;
      }

      await transaction.operationalIssueTransition.create({
        data: {
          issueId: activeIssue.id,
          operationalKey:
            activeIssue.operationalKey,
          issueCode: activeIssue.issueCode,

          fromWorkflowState:
            activeIssue.workflowState,
          toWorkflowState:
            PrismaOperationalWorkflowState.RESOLVED,

          transitionCode: resolutionCode,
          transitionSummary: resolutionSummary,
          transitionedBy:
            input.resolvedBy as PrismaOperationalActor,

          sourceType:
            input.sourceType as PrismaOperationalSourceType,
          decisionId:
            normalizeOptionalText(input.decisionId),
          sourceAuditEntryId:
            normalizeOptionalText(
              input.sourceAuditEntryId
            ),

          occurredAt,

          metadata: {
            reservationId,
            resolutionType,
          },
        },
      });

      resolvedIssueIds.push(activeIssue.id);
    }

    return {
      reservationId,
      resolvedCount: resolvedIssueIds.length,
      resolvedIssueIds,
      occurredAt,
    };
  });
}
