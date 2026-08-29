import type { PrismaClient } from "@prisma/client";

import {
  reopenOperationalIssue,
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service.js";
import {
  guestAccessE15MarkerStateFromPayload,
} from "../services/guest-access-exit-closure-a.policy.js";
import {
  GUEST_ACCESS_AMBIGUITY_ISSUE_CODE,
  GUEST_ACCESS_READINESS_ISSUE_CODE,
  GUEST_ACCESS_RECOVERY_ISSUE_CODE,
  type GuestAccessIssueProjection,
  type GuestAccessMissionSnapshot,
  projectGuestAccessAmbiguityIssue,
  projectGuestAccessReadinessIssue,
  projectGuestAccessRecoveryIssue,
  shouldPersistGuestAccessOperationalSignal,
} from "./guest-access-readiness-mission-control.policy.e14.js";

const ISSUE_CODES = [
  GUEST_ACCESS_READINESS_ISSUE_CODE,
  GUEST_ACCESS_RECOVERY_ISSUE_CODE,
  GUEST_ACCESS_AMBIGUITY_ISSUE_CODE,
] as const;

const reservationSelect = {
  id: true,
  reservationNumber: true,
  guestName: true,
  propertyId: true,
  status: true,
  guestAccessReleaseStatus: true,
  checkIn: true,
  checkOut: true,
  property: {
    select: {
      organizationId: true,
    },
  },
  accessGrants: {
    where: {
      type: "GUEST",
      method: "PASSCODE_TIMEBOUND",
    },
    select: {
      status: true,
      ttlockKeyboardPwdId: true,
      secureAccessCode: {
        select: { id: true },
      },
      recoveryOperation: true,
      recoveryNextAttemptAt: true,
      recoveryExhaustedAt: true,
      ttlockPayload: true,
    },
  },
} as const;

function toSnapshot(reservation: any): GuestAccessMissionSnapshot {
  return {
    reservationId: reservation.id,
    reservationNumber:
      reservation.reservationNumber ?? null,
    guestName: reservation.guestName ?? null,
    organizationId:
      reservation.property.organizationId,
    propertyId: reservation.propertyId,
    status: String(reservation.status),
    guestAccessReleaseStatus: String(
      reservation.guestAccessReleaseStatus
    ),
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    accessGrants: reservation.accessGrants.map(
      (grant: any) => ({
        status: String(grant.status),
        providerCredentialPresent:
          Boolean(grant.ttlockKeyboardPwdId),
        secureCodePresent:
          Boolean(grant.secureAccessCode),
        recoveryOperation:
          grant.recoveryOperation ?? null,
        recoveryNextAttemptAt:
          grant.recoveryNextAttemptAt ?? null,
        recoveryExhaustedAt:
          grant.recoveryExhaustedAt ?? null,
        e15MarkerState:
          guestAccessE15MarkerStateFromPayload(
            grant.ttlockPayload
          ),
      })
    ),
  };
}

async function persistActiveProjection(
  prisma: PrismaClient,
  snapshot: GuestAccessMissionSnapshot,
  projection: Extract<
    GuestAccessIssueProjection,
    { active: true }
  >,
  input: {
    now: Date;
    firstDetectedAt: Date;
    transitionCode: string;
    transitionSummary: string;
  }
) {
  await upsertOperationalIssue(prisma, {
    operationalKey: projection.operationalKey,
    issueCode: projection.issueCode,
    title: projection.title,
    issue: projection.issue,
    operationalImpact:
      projection.operationalImpact,
    recommendedAction:
      projection.recommendedAction,
    nextAutomaticStep:
      projection.nextAutomaticStep,
    engine: "ACCESS",
    severity: projection.severity,
    workflowState: projection.workflowState,
    visibility: projection.visibility,
    responsibleActor:
      projection.responsibleActor,
    actionRequired: projection.actionRequired,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    autoResolveActionCode: null,
    organizationId: snapshot.organizationId,
    propertyId: snapshot.propertyId,
    reservationId: snapshot.reservationId,
    reservationNumber:
      snapshot.reservationNumber,
    guestName: snapshot.guestName,
    sourceType: "WORKER",
    firstDetectedAt: input.firstDetectedAt,
    lastSignalAt: input.now,
    resolvedAt: null,
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
    actionTarget: "ACCESS",
    metadata: projection.metadata,
    transitionCode: input.transitionCode,
    transitionSummary:
      input.transitionSummary,
    transitionedBy: "PIN_GO",
    occurredAt: input.now,
  });
}

async function applyProjection(
  prisma: PrismaClient,
  snapshot: GuestAccessMissionSnapshot,
  projection: GuestAccessIssueProjection,
  now: Date
) {
  const existing = await prisma.operationalIssue.findUnique({
    where: {
      operationalKey: projection.operationalKey,
    },
    select: {
      workflowState: true,
      firstDetectedAt: true,
      lastSignalAt: true,
    },
  });

  if (!projection.active) {
    if (!existing || existing.workflowState === "RESOLVED") {
      return { action: "UNCHANGED" as const, writes: 0 };
    }

    await upsertOperationalIssue(prisma, {
      operationalKey: projection.operationalKey,
      issueCode: projection.issueCode,
      title: "Guest access condition resolved",
      issue:
        "The guest access condition no longer requires operational attention.",
      operationalImpact: null,
      recommendedAction: null,
      nextAutomaticStep: null,
      engine: "ACCESS",
      severity: "INFO",
      workflowState: "RESOLVED",
      visibility:
        projection.issueCode ===
        GUEST_ACCESS_AMBIGUITY_ISSUE_CODE
          ? "DEVELOPER"
          : projection.issueCode ===
              GUEST_ACCESS_RECOVERY_ISSUE_CODE
            ? "SYSTEM"
            : "HOST",
      responsibleActor: "PIN_GO",
      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode: null,
      organizationId: snapshot.organizationId,
      propertyId: snapshot.propertyId,
      reservationId: snapshot.reservationId,
      reservationNumber:
        snapshot.reservationNumber,
      guestName: snapshot.guestName,
      sourceType: "WORKER",
      firstDetectedAt: existing.firstDetectedAt,
      lastSignalAt: now,
      resolvedAt: now,
      resolutionCode:
        projection.resolutionCode,
      resolutionSummary:
        projection.resolutionSummary,
      resolutionType:
        projection.resolutionType,
      resolvedBy: "PIN_GO",
      actionTarget: "ACCESS",
      metadata: {
        contractVersion:
          "guest_access_readiness_mission_control_e14_v1",
        reservationId:
          snapshot.reservationId,
        propertyId: snapshot.propertyId,
        sanitized: true,
      },
      transitionCode:
        "GUEST_ACCESS_E14_CONDITION_RESOLVED",
      transitionSummary:
        projection.resolutionSummary,
      transitionedBy: "PIN_GO",
      occurredAt: now,
    });

    return { action: "RESOLVED" as const, writes: 1 };
  }

  if (existing?.workflowState === "RESOLVED") {
    await reopenOperationalIssue(prisma, {
      operationalKey: projection.operationalKey,
      workflowState: projection.workflowState,
      severity: projection.severity,
      responsibleActor:
        projection.responsibleActor,
      actionRequired:
        projection.actionRequired,
      recommendedAction:
        projection.recommendedAction,
      nextAutomaticStep:
        projection.nextAutomaticStep,
      canAutoResolve: true,
      autoResolveStatus: "AVAILABLE",
      autoResolveActionCode: null,
      reopenCode:
        "GUEST_ACCESS_E14_CONDITION_REOPENED",
      reopenSummary:
        "Current access evidence requires the workflow to be active again.",
      reopenedBy: "PIN_GO",
      sourceType: "WORKER",
      occurredAt: now,
      metadata: projection.metadata,
    });

    // The canonical reopen API intentionally updates lifecycle fields only.
    // Refresh host-safe title, issue, visibility and metadata immediately.
    await persistActiveProjection(
      prisma,
      snapshot,
      projection,
      {
        now,
        firstDetectedAt:
          existing.firstDetectedAt,
        transitionCode:
          "GUEST_ACCESS_E14_REOPEN_DETAILS_REFRESHED",
        transitionSummary:
          "Pin&Go refreshed the reopened guest access condition.",
      }
    );

    return { action: "REOPENED" as const, writes: 2 };
  }

  if (
    existing &&
    !shouldPersistGuestAccessOperationalSignal({
      existingWorkflowState:
        existing.workflowState,
      existingLastSignalAt:
        existing.lastSignalAt,
      nextWorkflowState:
        projection.workflowState,
      now,
    })
  ) {
    return { action: "UNCHANGED" as const, writes: 0 };
  }

  await persistActiveProjection(
    prisma,
    snapshot,
    projection,
    {
      now,
      firstDetectedAt:
        existing?.firstDetectedAt ?? now,
      transitionCode:
        existing
          ? "GUEST_ACCESS_E14_CONDITION_UPDATED"
          : "GUEST_ACCESS_E14_CONDITION_DETECTED",
      transitionSummary:
        existing
          ? "Pin&Go refreshed the current guest access condition."
          : "Pin&Go detected a current guest access condition.",
    }
  );

  return {
    action: existing ? "UPDATED" as const : "CREATED" as const,
    writes: 1,
  };
}

export async function syncGuestAccessReadinessMissionControl(
  prisma: PrismaClient,
  reservationId: string,
  input: {
    now?: Date;
    hostActionLeadMs?: number;
    e15Enabled?: boolean;
  } = {}
) {
  const now = input.now ?? new Date();
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: reservationSelect,
  });

  if (!reservation) {
    throw new Error(
      "GUEST_ACCESS_E14_RESERVATION_NOT_FOUND"
    );
  }

  const snapshot = toSnapshot(reservation);
  const readiness = projectGuestAccessReadinessIssue(
    snapshot,
    {
      now,
      ...(input.hostActionLeadMs !== undefined
        ? {
            hostActionLeadMs:
              input.hostActionLeadMs,
          }
        : {}),
    }
  );
  const recovery = projectGuestAccessRecoveryIssue(
    snapshot,
    { now }
  );
  const ambiguity = projectGuestAccessAmbiguityIssue(
    snapshot,
    {
      now,
      e15Enabled: input.e15Enabled === true,
    }
  );

  const [
    readinessResult,
    recoveryResult,
    ambiguityResult,
  ] = await Promise.all([
      applyProjection(
        prisma,
        snapshot,
        readiness,
        now
      ),
      applyProjection(
        prisma,
        snapshot,
        recovery,
        now
      ),
      applyProjection(
        prisma,
        snapshot,
        ambiguity,
        now
      ),
    ]);

  return {
    reservationId,
    readiness: readinessResult,
    recovery: recoveryResult,
    ambiguity: ambiguityResult,
    operationalIssueWrites:
      readinessResult.writes +
      recoveryResult.writes +
      ambiguityResult.writes,
    externalSideEffects: 0 as const,
  };
}

export async function findGuestAccessMissionControlReservationIds(
  prisma: PrismaClient,
  input: {
    now?: Date;
    horizonMs?: number;
    limit?: number;
  } = {}
) {
  const now = input.now ?? new Date();
  const horizon = new Date(
    now.getTime() +
      (input.horizonMs ?? 24 * 60 * 60_000)
  );
  const limit = input.limit ?? 100;

  const [upcoming, existingIssues] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        checkIn: { lte: horizon },
        checkOut: { gt: now },
        accessGrants: {
          some: {
            type: "GUEST",
            method: "PASSCODE_TIMEBOUND",
            status: {
              in: ["PENDING", "ACTIVE"],
            },
          },
        },
      },
      take: limit,
      orderBy: { checkIn: "asc" },
      select: { id: true },
    }),
    prisma.operationalIssue.findMany({
      where: {
        issueCode: { in: [...ISSUE_CODES] },
        workflowState: { not: "RESOLVED" },
        reservationId: { not: null },
      },
      take: limit,
      orderBy: { lastSignalAt: "asc" },
      select: { reservationId: true },
    }),
  ]);

  return Array.from(
    new Set([
      // Existing issues are ordered first so terminal resolution cannot be
      // starved by a full page of newly upcoming reservations.
      ...existingIssues
        .map((row: { reservationId: string | null }) =>
          row.reservationId
        )
        .filter((value: string | null): value is string =>
          Boolean(value)
        ),
      ...upcoming.map((row: { id: string }) => row.id),
    ])
  ).slice(0, limit);
}
