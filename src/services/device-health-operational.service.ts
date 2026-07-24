import { PrismaClient } from "@prisma/client";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";

const LOW_BATTERY_THRESHOLD = 30;
const CRITICAL_BATTERY_THRESHOLD = 20;
const UPCOMING_RESERVATION_WINDOW_MS =
  24 * 60 * 60 * 1000;

const BATTERY_TELEMETRY_WORKFLOW =
  "DEVICE_BATTERY_TELEMETRY";
const BATTERY_LEVEL_WORKFLOW =
  "DEVICE_BATTERY_LEVEL";

export type DeviceHealthOperationalInput = {
  prisma: PrismaClient;
  organizationId: string;
  propertyId: string;
  propertyName: string;
  lockId: string;
  lockName: string;
  lockIsActive: boolean;

  battery: number | null;
  batteryLastCheckedAt: Date | null;
  batteryLastSuccessfulAt: Date | null;
  batteryLastFailedAt: Date | null;
  batteryLastError: string | null;
  batteryNextCheckAt: Date | null;

  occurredAt?: Date;
};

function buildOperationalKey(
  workflow: string,
  lockId: string
) {
  return `${workflow}:${lockId}`;
}

function isLatestBatteryOutcomeFailure(
  input: DeviceHealthOperationalInput
) {
  if (
    !input.batteryLastFailedAt ||
    !input.batteryLastError
  ) {
    return false;
  }

  if (!input.batteryLastSuccessfulAt) {
    return true;
  }

  return (
    input.batteryLastFailedAt.getTime() >=
    input.batteryLastSuccessfulAt.getTime()
  );
}

async function loadOperationalReservation(
  input: DeviceHealthOperationalInput,
  occurredAt: Date
) {
  const windowEnd = new Date(
    occurredAt.getTime() +
      UPCOMING_RESERVATION_WINDOW_MS
  );

  return input.prisma.reservation.findFirst({
    where: {
      propertyId: input.propertyId,
      status: "ACTIVE",
      checkOut: {
        gt: occurredAt,
      },
      checkIn: {
        lte: windowEnd,
      },
    },
    orderBy: {
      checkIn: "asc",
    },
    select: {
      id: true,
      reservationNumber: true,
      guestName: true,
      checkIn: true,
      checkOut: true,
    },
  });
}

async function resolveExistingWorkflow(input: {
  prisma: PrismaClient;
  operationalKey: string;
  issueCode: string;
  title: string;
  issue: string;
  resolutionCode: string;
  resolutionSummary: string;
  organizationId: string;
  propertyId: string;
  lockId: string;
  lockName: string;
  propertyName: string;
  battery: number | null;
  occurredAt: Date;
}) {
  const existingIssue =
    await input.prisma.operationalIssue.findUnique({
      where: {
        operationalKey:
          input.operationalKey,
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

  const issue =
    await upsertOperationalIssue(
      input.prisma,
      {
        operationalKey:
          input.operationalKey,
        issueCode: input.issueCode,
        title: input.title,
        issue: input.issue,
        operationalImpact: null,
        recommendedAction: null,
        nextAutomaticStep: null,

        engine: "DEVICE_HEALTH",
        severity: "INFO",
        workflowState: "RESOLVED",
        visibility: "SYSTEM",
        responsibleActor: "NONE",

        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "SUCCEEDED",
        autoResolveActionCode: null,

        organizationId:
          input.organizationId,
        propertyId: input.propertyId,

        sourceType: "WORKER",

        resolvedAt: input.occurredAt,
        resolutionCode:
          input.resolutionCode,
        resolutionSummary:
          input.resolutionSummary,
        resolutionType: "AUTOMATIC",
        resolvedBy: "PIN_GO",

        actionTarget: "SYSTEM",

        metadata: {
          lockId: input.lockId,
          lockName: input.lockName,
          propertyName:
            input.propertyName,
          battery: input.battery,
          recoveredAt:
            input.occurredAt.toISOString(),
        },

        transitionCode:
          input.resolutionCode,
        transitionSummary:
          input.resolutionSummary,
        transitionedBy: "PIN_GO",
        occurredAt: input.occurredAt,
        lastSignalAt: input.occurredAt,
      }
    );

  return {
    applied: true as const,
    issueId: issue.id,
  };
}

async function synchronizeBatteryTelemetryWorkflow(
  input: DeviceHealthOperationalInput,
  occurredAt: Date
) {
  const operationalKey =
    buildOperationalKey(
      BATTERY_TELEMETRY_WORKFLOW,
      input.lockId
    );

  if (
    input.lockIsActive &&
    isLatestBatteryOutcomeFailure(input)
  ) {
    const nextAutomaticStep =
      input.batteryNextCheckAt
        ? `Pin&Go will request battery telemetry again at ${input.batteryNextCheckAt.toISOString()}.`
        : "Pin&Go will request battery telemetry again automatically.";

    const issue =
      await upsertOperationalIssue(
        input.prisma,
        {
          operationalKey,
          issueCode:
            "DEVICE_BATTERY_TELEMETRY_RETRY_SCHEDULED",
          title:
            "Battery telemetry is being recovered",
          issue:
            `Pin&Go could not read battery telemetry from ${input.lockName} at ${input.propertyName}.`,
          operationalImpact:
            "Battery condition cannot be confirmed until the next telemetry request succeeds.",
          recommendedAction: null,
          nextAutomaticStep,

          engine: "DEVICE_HEALTH",
          severity: "WARNING",
          workflowState: "WAITING",
          visibility: "SYSTEM",
          responsibleActor: "PIN_GO",

          actionRequired: false,
          canAutoResolve: true,
          autoResolveStatus: "AVAILABLE",
          autoResolveActionCode:
            "RECHECK_DEVICE_BATTERY",

          organizationId:
            input.organizationId,
          propertyId: input.propertyId,

          sourceType: "WORKER",
          actionTarget: "SYSTEM",

          metadata: {
            lockId: input.lockId,
            lockName: input.lockName,
            propertyName:
              input.propertyName,
            lastCheckedAt:
              input.batteryLastCheckedAt
                ?.toISOString() ?? null,
            lastFailedAt:
              input.batteryLastFailedAt
                ?.toISOString() ?? null,
            nextAttemptAt:
              input.batteryNextCheckAt
                ?.toISOString() ?? null,
            exhausted: false,
            lastError:
              input.batteryLastError,
          },

          transitionCode:
            "DEVICE_BATTERY_TELEMETRY_RETRY_SCHEDULED",
          transitionSummary:
            "Device Health retained ownership and scheduled another automatic battery telemetry request.",
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

  return resolveExistingWorkflow({
    prisma: input.prisma,
    operationalKey,
    issueCode:
      input.lockIsActive
        ? "DEVICE_BATTERY_TELEMETRY_RESTORED"
        : "DEVICE_BATTERY_TELEMETRY_SUPERSEDED",
    title:
      input.lockIsActive
        ? "Battery telemetry restored"
        : "Battery telemetry monitoring closed",
    issue:
      input.lockIsActive
        ? `Pin&Go confirmed battery telemetry for ${input.lockName}.`
        : `Pin&Go closed battery telemetry monitoring because ${input.lockName} is inactive.`,
    resolutionCode:
      input.lockIsActive
        ? "DEVICE_BATTERY_TELEMETRY_RECOVERED"
        : "DEVICE_LOCK_INACTIVE",
    resolutionSummary:
      input.lockIsActive
        ? "Pin&Go recovered battery telemetry automatically."
        : "Pin&Go closed battery telemetry recovery because the lock is inactive.",
    organizationId:
      input.organizationId,
    propertyId: input.propertyId,
    lockId: input.lockId,
    lockName: input.lockName,
    propertyName: input.propertyName,
    battery: input.battery,
    occurredAt,
  });
}

async function synchronizeBatteryLevelWorkflow(
  input: DeviceHealthOperationalInput,
  occurredAt: Date
) {
  const operationalKey =
    buildOperationalKey(
      BATTERY_LEVEL_WORKFLOW,
      input.lockId
    );

  const batteryLow =
    input.lockIsActive &&
    input.battery !== null &&
    input.battery <
      LOW_BATTERY_THRESHOLD;

  if (batteryLow) {
    const reservation =
      await loadOperationalReservation(
        input,
        occurredAt
      );

    const battery =
      Number(input.battery);
    const critical =
      battery <
      CRITICAL_BATTERY_THRESHOLD;

    const issue =
      await upsertOperationalIssue(
        input.prisma,
        {
          operationalKey,
          issueCode: critical
            ? "DEVICE_BATTERY_REPLACEMENT_CRITICAL"
            : "DEVICE_BATTERY_REPLACEMENT_REQUIRED",
          title: critical
            ? "Lock battery replacement is critical"
            : "Lock battery replacement is required",
          issue:
            `${input.lockName} at ${input.propertyName} reports ${battery}% battery.`,
          operationalImpact:
            reservation
              ? `A guest stay is active or begins within 24 hours, and lock reliability may be affected.`
              : "Lock reliability may be affected if the batteries are not replaced.",
          recommendedAction:
            "Replace the lock batteries and allow Pin&Go to confirm the new battery level.",
          nextAutomaticStep: null,

          engine: "DEVICE_HEALTH",
          severity: critical
            ? "CRITICAL"
            : "WARNING",
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
            input.organizationId,
          propertyId: input.propertyId,
          reservationId:
            reservation?.id ?? null,
          reservationNumber:
            reservation
              ?.reservationNumber ?? null,
          guestName:
            reservation?.guestName ?? null,

          sourceType: "WORKER",
          actionTarget: "ACCESS",

          metadata: {
            lockId: input.lockId,
            lockName: input.lockName,
            propertyName:
              input.propertyName,
            battery,
            lowBatteryThreshold:
              LOW_BATTERY_THRESHOLD,
            criticalBatteryThreshold:
              CRITICAL_BATTERY_THRESHOLD,
            lastCheckedAt:
              input.batteryLastCheckedAt
                ?.toISOString() ?? null,
            nextCheckAt:
              input.batteryNextCheckAt
                ?.toISOString() ?? null,
            reservationId:
              reservation?.id ?? null,
            reservationNumber:
              reservation
                ?.reservationNumber ?? null,
            checkIn:
              reservation?.checkIn
                .toISOString() ?? null,
            checkOut:
              reservation?.checkOut
                .toISOString() ?? null,
            exhausted: true,
          },

          transitionCode: critical
            ? "DEVICE_BATTERY_CRITICAL_DETECTED"
            : "DEVICE_BATTERY_LOW_DETECTED",
          transitionSummary: critical
            ? "Device Health detected a critical battery level that requires physical host action."
            : "Device Health detected a low battery level that requires physical host action.",
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

  return resolveExistingWorkflow({
    prisma: input.prisma,
    operationalKey,
    issueCode:
      input.lockIsActive
        ? "DEVICE_BATTERY_LEVEL_HEALTHY"
        : "DEVICE_BATTERY_MONITORING_SUPERSEDED",
    title:
      input.lockIsActive
        ? "Lock battery level restored"
        : "Lock battery monitoring closed",
    issue:
      input.lockIsActive
        ? `Pin&Go confirmed that ${input.lockName} is no longer below the battery replacement threshold.`
        : `Pin&Go closed battery monitoring because ${input.lockName} is inactive.`,
    resolutionCode:
      input.lockIsActive
        ? "DEVICE_BATTERY_REPLACED"
        : "DEVICE_LOCK_INACTIVE",
    resolutionSummary:
      input.lockIsActive
        ? "Pin&Go confirmed the lock battery returned to a healthy level."
        : "Pin&Go closed the battery workflow because the lock is inactive.",
    organizationId:
      input.organizationId,
    propertyId: input.propertyId,
    lockId: input.lockId,
    lockName: input.lockName,
    propertyName: input.propertyName,
    battery: input.battery,
    occurredAt,
  });
}

export async function synchronizeDeviceHealthOperationalIssues(
  input: DeviceHealthOperationalInput
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  const telemetry =
    await synchronizeBatteryTelemetryWorkflow(
      input,
      occurredAt
    );

  const batteryLevel =
    await synchronizeBatteryLevelWorkflow(
      input,
      occurredAt
    );

  return {
    telemetry,
    batteryLevel,
  };
}
