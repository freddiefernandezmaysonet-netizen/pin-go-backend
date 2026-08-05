import type {
  AccessStatus,
  PrismaClient,
} from "@prisma/client";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";

const GUEST_PASSCODE_REVOCATION_PREFIX =
  "GUEST_PASSCODE_REVOCATION";

function buildGuestPasscodeRevocationOperationalKey(
  accessGrantId: string
) {
  return `${GUEST_PASSCODE_REVOCATION_PREFIX}:${accessGrantId}`;
}

type GuestPasscodeRevocationOperationalContext = {
  prisma: PrismaClient;

  organizationId: string | null;
  propertyId: string | null;

  reservationId: string;
  reservationNumber?: string | null;
  guestName?: string | null;

  accessGrantId: string;
  accessGrantStatus: AccessStatus;

  attemptCount: number;
  error?: string | null;
  nextRetryAt?: Date | null;
  exhaustedAt?: Date | null;

  occurredAt?: Date;
};

function buildSharedMetadata(
  input: GuestPasscodeRevocationOperationalContext
) {
  return {
    reservationId: input.reservationId,
    accessGrantId: input.accessGrantId,
    operation: "REVOKE",
    attemptCount: input.attemptCount,
    error: input.error ?? null,
    nextRetryAt:
      input.nextRetryAt?.toISOString() ?? null,
    exhaustedAt:
      input.exhaustedAt?.toISOString() ?? null,
    finalStatus: input.accessGrantStatus,
  };
}

export async function markGuestPasscodeRevocationRecovering(
  input: GuestPasscodeRevocationOperationalContext
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey:
        buildGuestPasscodeRevocationOperationalKey(
          input.accessGrantId
        ),

      issueCode:
        "GUEST_PASSCODE_REVOCATION_RECOVERING",

      title:
        "Pin&Go is retrying guest passcode revocation",

      issue:
        "The previous TTLock revocation attempt failed and Pin&Go is recovering automatically.",

      operationalImpact:
        "The passcode remains under automatic recovery until TTLock confirms revocation.",

      recommendedAction:
        "No host action is required yet.",

      nextAutomaticStep:
        input.nextRetryAt
          ? `Pin&Go will retry after ${input.nextRetryAt.toISOString()}.`
          : "Pin&Go will retry after the active lease or configured backoff expires.",

      engine: "ACCESS",

      severity: "WARNING",
      workflowState: "AUTO_RESOLVING",
      visibility: "HOST",
      responsibleActor: "PIN_GO",

      actionRequired: false,

      canAutoResolve: true,
      autoResolveStatus: "RUNNING",
      autoResolveActionCode:
        "REVOKE_GUEST_PASSCODE",

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
        "GUEST_PASSCODE_REVOCATION_RECOVERING",

      transitionSummary:
        "Pin&Go is retrying guest passcode revocation automatically.",

      transitionedBy: "PIN_GO",
      occurredAt,
      lastSignalAt: occurredAt,
    }
  );
}

export async function escalateGuestPasscodeRevocationExhausted(
  input: GuestPasscodeRevocationOperationalContext
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey:
        buildGuestPasscodeRevocationOperationalKey(
          input.accessGrantId
        ),

      issueCode:
        "GUEST_PASSCODE_REVOCATION_EXHAUSTED",

      title:
        "Guest passcode revocation requires attention",

      issue:
        "Pin&Go exhausted the automatic attempts to revoke the guest passcode.",

      operationalImpact:
        "The passcode may still be active in TTLock after the reservation access window ended.",

      recommendedAction:
        "Verify the passcode in TTLock and revoke it manually before reusing the lock for another guest.",

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
        "GUEST_PASSCODE_REVOCATION_EXHAUSTED",

      transitionSummary:
        "Pin&Go exhausted automatic passcode revocation and escalated one host action.",

      transitionedBy: "PIN_GO",
      occurredAt,
      lastSignalAt: occurredAt,
    }
  );
}

export async function resolveGuestPasscodeRevocationIssue(
  input: GuestPasscodeRevocationOperationalContext
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  const operationalKey =
    buildGuestPasscodeRevocationOperationalKey(
      input.accessGrantId
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
        "GUEST_PASSCODE_REVOCATION_ISSUE_NOT_FOUND" as const,
    };
  }

  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey,

      issueCode:
        "GUEST_PASSCODE_REVOCATION_RESOLVED",

      title:
        "Guest passcode revoked",

      issue:
        "TTLock confirmed the guest passcode revocation.",

      operationalImpact:
        "The previous access recovery condition is resolved.",

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
        "REVOKE_GUEST_PASSCODE",

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
        "GUEST_PASSCODE_REVOKED_AUTOMATICALLY",
      resolutionSummary:
        "Pin&Go confirmed TTLock revocation and closed the access recovery issue.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",

      actionTarget: "ACCESS",

      metadata: buildSharedMetadata({
        ...input,
        attemptCount: 0,
        error: null,
        nextRetryAt: null,
        exhaustedAt: null,
      }),

      transitionCode:
        "GUEST_PASSCODE_REVOCATION_RESOLVED",

      transitionSummary:
        "TTLock confirmed revocation and Pin&Go resolved the access recovery issue.",

      transitionedBy: "PIN_GO",
      occurredAt,
      lastSignalAt: occurredAt,
    }
  );
}