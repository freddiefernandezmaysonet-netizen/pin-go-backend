import type { PrismaClient } from "@prisma/client";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service";

function operationalKey(lockId: string) {
  return `DEVICE_GATEWAY_MAINTENANCE:${lockId}`;
}

export async function markGatewayMaintenanceWaiting(input: {
  prisma: PrismaClient;
  organizationId: string;
  propertyId: string;
  lockId: string;
  lockName: string;
  propertyName: string;
  nextCheckAt: Date;
  stage: string;
  occurredAt: Date;
}) {
  return upsertOperationalIssue(input.prisma, {
    operationalKey: operationalKey(input.lockId),
    issueCode: "DEVICE_GATEWAY_REVALIDATION_PENDING",
    title: "Gateway connectivity is being revalidated",
    issue:
      `Pin&Go could not confirm gateway connectivity for ${input.propertyName}.`,
    operationalImpact:
      "Remote lock operations may be unavailable if gateway connectivity does not recover.",
    recommendedAction: null,
    nextAutomaticStep:
      `Pin&Go will recheck the gateway automatically at ${input.nextCheckAt.toISOString()}.`,
    engine: "ACCESS",
    severity: "WARNING",
    workflowState: "WAITING",
    visibility: "SYSTEM",
    responsibleActor: "PIN_GO",
    actionRequired: false,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    autoResolveActionCode: "RECHECK_DEVICE_GATEWAY",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    reservationId: null,
    reservationNumber: null,
    sourceType: "WORKER",
    actionTarget: "ACCESS",
    metadata: {
      lockId: input.lockId,
      lockName: input.lockName,
      propertyName: input.propertyName,
      nextCheckAt: input.nextCheckAt.toISOString(),
      retryStage: input.stage,
    },
    transitionCode: "DEVICE_GATEWAY_REVALIDATION_SCHEDULED",
    transitionSummary:
      "Pin&Go scheduled another automatic gateway connectivity check.",
    transitionedBy: "PIN_GO",
    occurredAt: input.occurredAt,
    lastSignalAt: input.occurredAt,
  });
}

export async function markGatewayMaintenanceActionRequired(input: {
  prisma: PrismaClient;
  organizationId: string;
  propertyId: string;
  lockId: string;
  lockName: string;
  propertyName: string;
  nextCheckAt: Date;
  occurredAt: Date;
}) {
  return upsertOperationalIssue(input.prisma, {
    operationalKey: operationalKey(input.lockId),
    issueCode: "DEVICE_GATEWAY_PERSISTENTLY_UNAVAILABLE",
    title: "Gateway needs attention",
    issue:
      `Pin&Go has repeatedly failed to confirm gateway connectivity for ${input.propertyName}.`,
    operationalImpact:
      "Remote lock operations and gateway-based battery telemetry may be unavailable.",
    recommendedAction:
      "Verify that the gateway has power, internet access, and remains paired with the lock.",
    nextAutomaticStep:
      `Pin&Go will continue one automatic recovery check per day. Next check: ${input.nextCheckAt.toISOString()}.`,
    engine: "ACCESS",
    severity: "WARNING",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    responsibleActor: "HOST",
    actionRequired: true,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    autoResolveActionCode: "RECHECK_DEVICE_GATEWAY",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    reservationId: null,
    reservationNumber: null,
    sourceType: "WORKER",
    actionTarget: "ACCESS",
    metadata: {
      lockId: input.lockId,
      lockName: input.lockName,
      propertyName: input.propertyName,
      nextCheckAt: input.nextCheckAt.toISOString(),
    },
    transitionCode: "DEVICE_GATEWAY_HOST_ACTION_REQUIRED",
    transitionSummary:
      "Gateway connectivity remained unavailable after the staged automatic revalidation window.",
    transitionedBy: "PIN_GO",
    occurredAt: input.occurredAt,
    lastSignalAt: input.occurredAt,
  });
}

export async function resolveGatewayMaintenanceIssue(input: {
  prisma: PrismaClient;
  organizationId: string;
  propertyId: string;
  lockId: string;
  lockName: string;
  propertyName: string;
  occurredAt: Date;
}) {
  const key = operationalKey(input.lockId);
  const existing = await input.prisma.operationalIssue.findUnique({
    where: { operationalKey: key },
    select: { id: true, workflowState: true },
  });

  if (!existing || existing.workflowState === "RESOLVED") {
    return null;
  }

  return upsertOperationalIssue(input.prisma, {
    operationalKey: key,
    issueCode: "DEVICE_GATEWAY_RECOVERED",
    title: "Gateway connectivity restored",
    issue:
      `Pin&Go confirmed that the gateway for ${input.propertyName} is available again.`,
    operationalImpact: null,
    recommendedAction: null,
    nextAutomaticStep: null,
    engine: "ACCESS",
    severity: "INFO",
    workflowState: "RESOLVED",
    visibility: "SYSTEM",
    responsibleActor: "PIN_GO",
    actionRequired: false,
    canAutoResolve: true,
    autoResolveStatus: "SUCCEEDED",
    autoResolveActionCode: "RECHECK_DEVICE_GATEWAY",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    reservationId: null,
    reservationNumber: null,
    sourceType: "WORKER",
    actionTarget: "ACCESS",
    resolutionCode: "DEVICE_GATEWAY_AUTO_RECOVERED",
    resolutionSummary:
      "Pin&Go automatically confirmed gateway connectivity recovery.",
    resolutionType: "AUTOMATIC",
    resolvedBy: "PIN_GO",
    metadata: {
      lockId: input.lockId,
      lockName: input.lockName,
      propertyName: input.propertyName,
    },
    transitionCode: "DEVICE_GATEWAY_RECOVERED",
    transitionSummary:
      "The gateway maintenance workflow auto-resolved after a successful connectivity check.",
    transitionedBy: "PIN_GO",
    occurredAt: input.occurredAt,
    lastSignalAt: input.occurredAt,
    resolvedAt: input.occurredAt,
  });
}
