import { PrismaClient } from "@prisma/client";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";

function buildOperationalKey(input: {
  accessGrantId: string;
  operation: string;
}) {
  return [
    "ACCESS_RECOVERY",
    input.operation,
    input.accessGrantId,
  ].join(":");
}

function getOperationLabel(operation: string) {
  return operation === "REVOKE"
    ? "guest access revocation"
    : "access recovery";
}

async function loadAccessRecoveryContext(input: {
  prisma: PrismaClient;
  accessGrantId: string;
}) {
  const grant =
    await input.prisma.accessGrant.findUnique({
      where: {
        id: input.accessGrantId,
      },
      select: {
        id: true,
        reservationId: true,
        reservation: {
          select: {
            reservationNumber: true,
            guestName: true,
            propertyId: true,
            property: {
              select: {
                name: true,
                organizationId: true,
              },
            },
          },
        },
        lock: {
          select: {
            id: true,
            propertyId: true,
            locationLabel: true,
            ttlockLockName: true,
            property: {
              select: {
                name: true,
                organizationId: true,
              },
            },
          },
        },
      },
    });

  if (!grant) {
    return null;
  }

  const property =
    grant.reservation?.property ??
    grant.lock.property;

  return {
    accessGrantId: grant.id,
    lockId: grant.lock.id,
    lockName:
      grant.lock.locationLabel?.trim() ||
      grant.lock.ttlockLockName?.trim() ||
      "Property lock",
    organizationId:
      property.organizationId,
    propertyId:
      grant.reservation?.propertyId ??
      grant.lock.propertyId,
    propertyName:
      property.name,
    reservationId:
      grant.reservationId,
    reservationNumber:
      grant.reservation
        ?.reservationNumber ?? null,
    guestName:
      grant.reservation?.guestName ?? null,
  };
}

export async function recordAccessRecoveryOperationalFailure(
  input: {
    prisma: PrismaClient;
    accessGrantId: string;
    operation: string;
    attemptCount: number;
    maxAttempts: number;
    lastError: string;
    nextAttemptAt: Date | null;
    exhausted: boolean;
    occurredAt?: Date;
  }
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  const context =
    await loadAccessRecoveryContext({
      prisma: input.prisma,
      accessGrantId:
        input.accessGrantId,
    });

  if (!context) {
    return {
      applied: false as const,
      reason:
        "ACCESS_GRANT_NOT_FOUND" as const,
    };
  }

  const operationLabel =
    getOperationLabel(input.operation);

  const operationalKey =
    buildOperationalKey({
      accessGrantId:
        input.accessGrantId,
      operation: input.operation,
    });

  if (input.exhausted) {
    const issue =
      await upsertOperationalIssue(
        input.prisma,
        {
          operationalKey,
          issueCode:
            "ACCESS_REVOKE_RECOVERY_EXHAUSTED",
          title:
            "Guest access revoke requires host action",
          issue:
            `Pin&Go exhausted ${input.maxAttempts} automatic attempts to complete ${operationLabel} for ${context.propertyName}.`,
          operationalImpact:
            "The guest credential may remain active at the lock until revocation is confirmed.",
          recommendedAction:
            "Review TTLock connectivity and complete the guest access revocation.",
          nextAutomaticStep: null,

          engine: "ACCESS",
          severity: "CRITICAL",
          workflowState:
            "ACTION_REQUIRED",
          visibility: "HOST",
          responsibleActor: "HOST",

          actionRequired: true,
          canAutoResolve: false,
          autoResolveStatus:
            "NOT_SUPPORTED",
          autoResolveActionCode: null,

          organizationId:
            context.organizationId,
          propertyId:
            context.propertyId,
          reservationId:
            context.reservationId,
          reservationNumber:
            context.reservationNumber,
          guestName:
            context.guestName,

          decisionId:
            `access-recovery:${input.operation}:${input.accessGrantId}`,
          sourceType: "WORKER",

          actionTarget: "ACCESS",

          metadata: {
            accessGrantId:
              input.accessGrantId,
            operation: input.operation,
            attempt:
              input.attemptCount,
            maxAttempts:
              input.maxAttempts,
            nextAttemptAt: null,
            exhausted: true,
            lastError:
              input.lastError,
            lockId: context.lockId,
            lockName:
              context.lockName,
            propertyName:
              context.propertyName,
            reservationNumber:
              context.reservationNumber,
          },

          transitionCode:
            "ACCESS_RECOVERY_EXHAUSTED",
          transitionSummary:
            "Access Recovery exhausted its automatic retry budget and transferred responsibility to the host.",
          transitionedBy: "PIN_GO",
          occurredAt,
          lastSignalAt: occurredAt,
        }
      );

    return {
      applied: true as const,
      issueId: issue.id,
      workflowState:
        issue.workflowState,
    };
  }

  const nextAttemptAt =
    input.nextAttemptAt;

  const issue =
    await upsertOperationalIssue(
      input.prisma,
      {
        operationalKey,
        issueCode:
          "ACCESS_REVOKE_RETRY_SCHEDULED",
        title:
          "Pin&Go is retrying guest access revocation",
        issue:
          `Pin&Go could not confirm ${operationLabel} for ${context.propertyName} and retained ownership of the recovery workflow.`,
        operationalImpact:
          "The guest credential may remain active until the next automatic attempt succeeds.",
        recommendedAction: null,
        nextAutomaticStep:
          nextAttemptAt
            ? `Pin&Go will attempt the revocation again at ${nextAttemptAt.toISOString()}.`
            : "Pin&Go will attempt the revocation again automatically.",

        engine: "ACCESS",
        severity: "WARNING",
        workflowState: "WAITING",
        visibility: "HOST",
        responsibleActor: "PIN_GO",

        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "AVAILABLE",
        autoResolveActionCode:
          "RETRY_ACCESS_REVOKE",

        organizationId:
          context.organizationId,
        propertyId:
          context.propertyId,
        reservationId:
          context.reservationId,
        reservationNumber:
          context.reservationNumber,
        guestName:
          context.guestName,

        decisionId:
          `access-recovery:${input.operation}:${input.accessGrantId}`,
        sourceType: "WORKER",

        actionTarget: "ACCESS",

        metadata: {
          accessGrantId:
            input.accessGrantId,
          operation: input.operation,
          attempt:
            input.attemptCount,
          maxAttempts:
            input.maxAttempts,
          nextAttemptAt:
            nextAttemptAt
              ?.toISOString() ?? null,
          exhausted: false,
          lastError:
            input.lastError,
          lockId: context.lockId,
          lockName:
            context.lockName,
          propertyName:
            context.propertyName,
          reservationNumber:
            context.reservationNumber,
        },

        transitionCode:
          "ACCESS_RECOVERY_RETRY_SCHEDULED",
        transitionSummary:
          `Access Recovery scheduled automatic attempt ${input.attemptCount + 1} of ${input.maxAttempts}.`,
        transitionedBy: "PIN_GO",
        occurredAt,
        lastSignalAt: occurredAt,
      }
    );

  return {
    applied: true as const,
    issueId: issue.id,
    workflowState:
      issue.workflowState,
  };
}

export async function resolveAccessRecoveryOperationalIssue(
  input: {
    prisma: PrismaClient;
    accessGrantId: string;
    operation: string;
    occurredAt?: Date;
  }
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  const operationalKey =
    buildOperationalKey({
      accessGrantId:
        input.accessGrantId,
      operation: input.operation,
    });

  const existingIssue =
    await input.prisma.operationalIssue.findUnique({
      where: {
        operationalKey,
      },
      select: {
        id: true,
      },
    });

  if (!existingIssue) {
    return {
      applied: false as const,
      reason:
        "OPERATIONAL_ISSUE_NOT_FOUND" as const,
    };
  }

  const context =
    await loadAccessRecoveryContext({
      prisma: input.prisma,
      accessGrantId:
        input.accessGrantId,
    });

  if (!context) {
    return {
      applied: false as const,
      reason:
        "ACCESS_GRANT_NOT_FOUND" as const,
    };
  }

  const issue =
    await upsertOperationalIssue(
      input.prisma,
      {
        operationalKey,
        issueCode:
          "ACCESS_REVOKE_RECOVERED",
        title:
          "Guest access revocation recovered",
        issue:
          `Pin&Go confirmed guest access revocation for ${context.propertyName} after automatic recovery.`,
        operationalImpact: null,
        recommendedAction: null,
        nextAutomaticStep: null,

        engine: "ACCESS",
        severity: "INFO",
        workflowState: "RESOLVED",
        visibility: "HOST",
        responsibleActor: "NONE",

        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "SUCCEEDED",
        autoResolveActionCode: null,

        organizationId:
          context.organizationId,
        propertyId:
          context.propertyId,
        reservationId:
          context.reservationId,
        reservationNumber:
          context.reservationNumber,
        guestName:
          context.guestName,

        decisionId:
          `access-recovery:${input.operation}:${input.accessGrantId}`,
        sourceType: "WORKER",

        resolvedAt: occurredAt,
        resolutionCode:
          "ACCESS_RECOVERY_SUCCEEDED",
        resolutionSummary:
          "Pin&Go completed guest access revocation without host intervention.",
        resolutionType: "AUTOMATIC",
        resolvedBy: "PIN_GO",

        actionTarget: "ACCESS",

        metadata: {
          accessGrantId:
            input.accessGrantId,
          operation: input.operation,
          exhausted: false,
          lockId: context.lockId,
          lockName:
            context.lockName,
          propertyName:
            context.propertyName,
          reservationNumber:
            context.reservationNumber,
          recoveredAt:
            occurredAt.toISOString(),
        },

        transitionCode:
          "ACCESS_RECOVERY_SUCCEEDED",
        transitionSummary:
          "Access Recovery confirmed remote revocation and resolved the operational issue automatically.",
        transitionedBy: "PIN_GO",
        occurredAt,
        lastSignalAt: occurredAt,
      }
    );

  return {
    applied: true as const,
    issueId: issue.id,
    workflowState:
      issue.workflowState,
  };
}
