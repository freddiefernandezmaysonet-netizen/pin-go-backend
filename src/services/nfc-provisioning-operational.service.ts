import type {
  NfcAssignmentRole,
  NfcAssignmentStatus,
  PrismaClient,
} from "@prisma/client";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";

const NFC_PROVISIONING_PREFIX =
  "NFC_PROVISIONING";

function buildNfcProvisioningOperationalKey(
  nfcAssignmentId: string
) {
  return `${NFC_PROVISIONING_PREFIX}:${nfcAssignmentId}`;
}

type NfcProvisioningOperationalContext = {
  prisma: PrismaClient;

  organizationId: string | null;
  propertyId: string | null;

  reservationId: string;
  reservationNumber?: string | null;
  guestName?: string | null;

  nfcAssignmentId: string;
  nfcCardId: string;
  role: NfcAssignmentRole;
  assignmentStatus: NfcAssignmentStatus;

  attemptCount: number;
  error?: string | null;
  retryable: boolean;
  exhausted: boolean;

  occurredAt?: Date;
};

function buildSharedMetadata(
  input: NfcProvisioningOperationalContext
) {
  return {
    reservationId: input.reservationId,
    nfcAssignmentId: input.nfcAssignmentId,
    nfcCardId: input.nfcCardId,
    role: input.role,
    operation: "PROVISION_NFC",
    attemptCount: input.attemptCount,
    error: input.error ?? null,
    retryable: input.retryable,
    exhausted: input.exhausted,
    finalStatus: input.assignmentStatus,
  };
}

function resolveSubject(
  role: NfcAssignmentRole
) {
  return role === "CLEANING"
    ? "cleaning NFC access"
    : "guest NFC access";
}

export async function markNfcProvisioningRecovering(
  input: NfcProvisioningOperationalContext
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  const subject = resolveSubject(input.role);

  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey:
        buildNfcProvisioningOperationalKey(
          input.nfcAssignmentId
        ),

      issueCode:
        "NFC_PROVISIONING_RECOVERING",

      title:
        `Pin&Go is retrying ${subject}`,

      issue:
        `The previous TTLock provisioning attempt for ${subject} failed and Pin&Go is recovering automatically.`,

      operationalImpact:
        `The NFC credential is not confirmed active yet, but automatic retries remain available.`,

      recommendedAction:
        "No host action is required yet.",

      nextAutomaticStep:
        "Pin&Go will retry during a subsequent reservation worker cycle.",

      engine: "ACCESS",

      severity: "WARNING",
      workflowState: "AUTO_RESOLVING",
      visibility: "HOST",
      responsibleActor: "PIN_GO",

      actionRequired: false,

      canAutoResolve: true,
      autoResolveStatus: "RUNNING",
      autoResolveActionCode:
        "PROVISION_NFC_ACCESS",

      organizationId: input.organizationId,
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      reservationNumber:
        input.reservationNumber ?? null,

      guestName: input.guestName ?? null,
      staffMemberId: null,
      cleanerName: null,

      sourceType: "WORKER",

      actionTarget: "ACCESS",

      metadata: buildSharedMetadata(input),

      transitionCode:
        "NFC_PROVISIONING_RECOVERING",

      transitionSummary:
        "Pin&Go is retrying NFC provisioning automatically.",

      transitionedBy: "PIN_GO",
      occurredAt,
      lastSignalAt: occurredAt,
    }
  );
}

export async function escalateNfcProvisioningFailure(
  input: NfcProvisioningOperationalContext
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  const subject = resolveSubject(input.role);

  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey:
        buildNfcProvisioningOperationalKey(
          input.nfcAssignmentId
        ),

      issueCode:
        "NFC_PROVISIONING_ACTION_REQUIRED",

      title:
        `${subject} requires attention`,

      issue:
        input.exhausted
          ? `Pin&Go exhausted the automatic attempts to provision ${subject}.`
          : `Pin&Go cannot automatically provision ${subject} because the failure is not retryable.`,

      operationalImpact:
        `The NFC credential is not confirmed active for its scheduled access window.`,

      recommendedAction:
        "Verify the NFC card and lock in TTLock, then repair or replace the credential before the access window.",

      nextAutomaticStep: null,

      engine: "ACCESS",

      severity: "CRITICAL",
      workflowState: "ACTION_REQUIRED",
      visibility: "HOST",
      responsibleActor: "HOST",

      actionRequired: true,

      canAutoResolve: false,
      autoResolveStatus: "NOT_SUPPORTED",
      autoResolveActionCode: null,

      organizationId: input.organizationId,
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      reservationNumber:
        input.reservationNumber ?? null,

      guestName: input.guestName ?? null,
      staffMemberId: null,
      cleanerName: null,

      sourceType: "WORKER",

      actionTarget: "ACCESS",

      metadata: buildSharedMetadata(input),

      transitionCode:
        "NFC_PROVISIONING_ACTION_REQUIRED",

      transitionSummary:
        "Pin&Go escalated the NFC provisioning failure for host attention.",

      transitionedBy: "PIN_GO",
      occurredAt,
      lastSignalAt: occurredAt,
    }
  );
}

export async function resolveNfcProvisioningIssue(
  input: NfcProvisioningOperationalContext
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  const operationalKey =
    buildNfcProvisioningOperationalKey(
      input.nfcAssignmentId
    );

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
        "NFC_PROVISIONING_ISSUE_NOT_FOUND" as const,
    };
  }

  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey,

      issueCode:
        "NFC_PROVISIONING_RESOLVED",

      title:
        "NFC access provisioned",

      issue:
        "TTLock confirmed the NFC credential access window.",

      operationalImpact:
        "The previous NFC provisioning condition is resolved.",

      recommendedAction:
        "No host action is required.",

      nextAutomaticStep: null,

      engine: "ACCESS",

      severity: "INFO",
      workflowState: "RESOLVED",
      visibility: "SYSTEM",
      responsibleActor: "NONE",

      actionRequired: false,

      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode:
        "PROVISION_NFC_ACCESS",

      organizationId: input.organizationId,
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      reservationNumber:
        input.reservationNumber ?? null,

      guestName: input.guestName ?? null,
      staffMemberId: null,
      cleanerName: null,

      sourceType: "WORKER",

      resolvedAt: occurredAt,
      resolutionCode:
        "NFC_PROVISIONED_AUTOMATICALLY",
      resolutionSummary:
        "Pin&Go confirmed NFC provisioning in TTLock and closed the recovery issue.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",

      actionTarget: "ACCESS",

      metadata: buildSharedMetadata({
        ...input,
        error: null,
        retryable: false,
        exhausted: false,
      }),

      transitionCode:
        "NFC_PROVISIONING_RESOLVED",

      transitionSummary:
        "TTLock confirmed NFC provisioning and Pin&Go resolved the access recovery issue.",

      transitionedBy: "PIN_GO",
      occurredAt,
      lastSignalAt: occurredAt,
    }
  );
}