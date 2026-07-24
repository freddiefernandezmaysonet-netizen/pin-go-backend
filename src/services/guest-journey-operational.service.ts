import {
  GuestJourneyState,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";
import {
  ensureGuestJourneyForConfirmedReservation,
} from "./guest-journey.service";

const MONITORING_WINDOW_MS =
  24 * 60 * 60 * 1000;
const HOST_ACTION_WINDOW_MS =
  2 * 60 * 60 * 1000;
const SIGNAL_REFRESH_INTERVAL_MS =
  5 * 60 * 1000;

const ACTIVE_ISSUE_ENGINE_NAMES = [
  "GUEST_JOURNEY",
  "Guest Journey",
] as const;

export type GuestJourneyOperationalInput = {
  prisma: PrismaClient;
  journeyId: string;
  reservationId: string;
  reservationNumber?: string | null;
  guestName?: string | null;
  organizationId: string;
  propertyId: string;
  propertyName: string;
  reservationStatus: ReservationStatus;
  checkIn: Date;
  checkOut: Date;
  currentState: GuestJourneyState;
  stateChangedAt: Date;
  guestAccessReleaseStatus?: string | null;
  occurredAt?: Date;
};

function buildOperationalKey(
  reservationId: string
) {
  return `GUEST_JOURNEY:${reservationId}`;
}

function getCriticalAt(checkIn: Date) {
  return new Date(
    checkIn.getTime() -
      HOST_ACTION_WINDOW_MS
  );
}

function getMonitoringAt(checkIn: Date) {
  return new Date(
    checkIn.getTime() -
      MONITORING_WINDOW_MS
  );
}

async function shouldCoalesceSignal(input: {
  prisma: PrismaClient;
  operationalKey: string;
  issueCode: string;
  workflowState:
    | "WAITING"
    | "AUTO_RESOLVING"
    | "ACTION_REQUIRED";
  occurredAt: Date;
}) {
  const existingIssue =
    await input.prisma.operationalIssue.findUnique({
      where: {
        operationalKey:
          input.operationalKey,
      },
      select: {
        issueCode: true,
        workflowState: true,
        lastSignalAt: true,
      },
    });

  if (!existingIssue) {
    return false;
  }

  return (
    existingIssue.issueCode ===
      input.issueCode &&
    existingIssue.workflowState ===
      input.workflowState &&
    input.occurredAt.getTime() -
      existingIssue.lastSignalAt.getTime() <
      SIGNAL_REFRESH_INTERVAL_MS
  );
}

async function resolveExistingGuestJourneyIssue(input: {
  context: GuestJourneyOperationalInput;
  issueCode: string;
  title: string;
  issue: string;
  resolutionCode: string;
  resolutionSummary: string;
  resolutionType:
    | "AUTOMATIC"
    | "SUPERSEDED";
  resolvedBy: "PIN_GO";
  occurredAt: Date;
}) {
  const operationalKey =
    buildOperationalKey(
      input.context.reservationId
    );

  const existingIssue =
    await input.context.prisma.operationalIssue.findUnique({
      where: {
        operationalKey,
      },
      select: {
        id: true,
        workflowState: true,
      },
    });

  if (
    !existingIssue ||
    existingIssue.workflowState ===
      "RESOLVED"
  ) {
    return {
      applied: false as const,
      reason:
        "OPERATIONAL_ISSUE_NOT_ACTIVE" as const,
    };
  }

  const operationalIssue =
    await upsertOperationalIssue(
      input.context.prisma,
      {
        operationalKey,
        issueCode: input.issueCode,
        title: input.title,
        issue: input.issue,
        operationalImpact: null,
        recommendedAction: null,
        nextAutomaticStep: null,

        engine: "GUEST_JOURNEY",
        severity: "INFO",
        workflowState: "RESOLVED",
        visibility: "HOST",
        responsibleActor: "NONE",

        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "SUCCEEDED",
        autoResolveActionCode: null,

        organizationId:
          input.context.organizationId,
        propertyId:
          input.context.propertyId,
        reservationId:
          input.context.reservationId,
        reservationNumber:
          input.context.reservationNumber ??
          null,
        guestName:
          input.context.guestName ?? null,

        sourceType: "WORKER",

        resolvedAt: input.occurredAt,
        resolutionCode:
          input.resolutionCode,
        resolutionSummary:
          input.resolutionSummary,
        resolutionType:
          input.resolutionType,
        resolvedBy: input.resolvedBy,

        actionTarget: "GUEST",

        metadata: {
          journeyId:
            input.context.journeyId,
          guestJourneyState:
            input.context.currentState,
          propertyName:
            input.context.propertyName,
          checkIn:
            input.context.checkIn.toISOString(),
          checkOut:
            input.context.checkOut.toISOString(),
          guestAccessReleaseStatus:
            input.context
              .guestAccessReleaseStatus ?? null,
          resolvedAt:
            input.occurredAt.toISOString(),
          exhausted: false,
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
    issueId: operationalIssue.id,
    workflowState:
      operationalIssue.workflowState,
  };
}

async function upsertGuestJourneyActiveIssue(input: {
  context: GuestJourneyOperationalInput;
  issueCode: string;
  title: string;
  issue: string;
  operationalImpact: string;
  recommendedAction: string | null;
  nextAutomaticStep: string | null;
  severity: "INFO" | "WARNING" | "CRITICAL";
  workflowState:
    | "WAITING"
    | "AUTO_RESOLVING"
    | "ACTION_REQUIRED";
  responsibleActor:
    | "PIN_GO"
    | "GUEST"
    | "HOST";
  canAutoResolve: boolean;
  autoResolveStatus:
    | "AVAILABLE"
    | "RUNNING"
    | "NOT_SUPPORTED";
  nextAttemptAt: Date | null;
  exhausted: boolean;
  occurredAt: Date;
}) {
  const operationalKey =
    buildOperationalKey(
      input.context.reservationId
    );

  if (
    await shouldCoalesceSignal({
      prisma: input.context.prisma,
      operationalKey,
      issueCode: input.issueCode,
      workflowState:
        input.workflowState,
      occurredAt: input.occurredAt,
    })
  ) {
    return {
      applied: false as const,
      coalesced: true as const,
    };
  }

  const operationalIssue =
    await upsertOperationalIssue(
      input.context.prisma,
      {
        operationalKey,
        issueCode: input.issueCode,
        title: input.title,
        issue: input.issue,
        operationalImpact:
          input.operationalImpact,
        recommendedAction:
          input.recommendedAction,
        nextAutomaticStep:
          input.nextAutomaticStep,

        engine: "GUEST_JOURNEY",
        severity: input.severity,
        workflowState:
          input.workflowState,
        visibility: "HOST",
        responsibleActor:
          input.responsibleActor,

        actionRequired:
          input.workflowState ===
          "ACTION_REQUIRED",
        canAutoResolve:
          input.canAutoResolve,
        autoResolveStatus:
          input.autoResolveStatus,
        autoResolveActionCode:
          input.canAutoResolve
            ? "RECONCILE_GUEST_JOURNEY"
            : null,

        organizationId:
          input.context.organizationId,
        propertyId:
          input.context.propertyId,
        reservationId:
          input.context.reservationId,
        reservationNumber:
          input.context.reservationNumber ??
          null,
        guestName:
          input.context.guestName ?? null,

        sourceType: "WORKER",
        actionTarget: "GUEST",

        metadata: {
          journeyId:
            input.context.journeyId,
          guestJourneyState:
            input.context.currentState,
          stateChangedAt:
            input.context.stateChangedAt
              .toISOString(),
          propertyName:
            input.context.propertyName,
          checkIn:
            input.context.checkIn.toISOString(),
          checkOut:
            input.context.checkOut.toISOString(),
          monitoringAt:
            getMonitoringAt(
              input.context.checkIn
            ).toISOString(),
          criticalAt:
            getCriticalAt(
              input.context.checkIn
            ).toISOString(),
          nextAttemptAt:
            input.nextAttemptAt
              ?.toISOString() ?? null,
          exhausted: input.exhausted,
          guestAccessReleaseStatus:
            input.context
              .guestAccessReleaseStatus ?? null,
        },

        transitionCode:
          input.issueCode,
        transitionSummary:
          input.workflowState ===
          "ACTION_REQUIRED"
            ? "Guest Journey reached the host-action deadline without completed verification."
            : "Guest Journey retained ownership and recorded its next automatic step.",
        transitionedBy: "PIN_GO",
        occurredAt: input.occurredAt,
        lastSignalAt: input.occurredAt,
      }
    );

  return {
    applied: true as const,
    coalesced: false as const,
    issueId: operationalIssue.id,
    workflowState:
      operationalIssue.workflowState,
  };
}

export async function synchronizeGuestJourneyOperationalIssue(
  input: GuestJourneyOperationalInput
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  if (
    input.reservationStatus !==
      ReservationStatus.ACTIVE ||
    input.checkOut <= occurredAt
  ) {
    return resolveExistingGuestJourneyIssue({
      context: input,
      issueCode:
        "GUEST_JOURNEY_SUPERSEDED",
      title:
        "Guest journey monitoring closed",
      issue:
        "Pin&Go closed the guest journey because the reservation is no longer operational.",
      resolutionCode:
        "RESERVATION_NO_LONGER_OPERATIONAL",
      resolutionSummary:
        "Pin&Go closed the guest journey because the reservation was cancelled or the stay ended.",
      resolutionType: "SUPERSEDED",
      resolvedBy: "PIN_GO",
      occurredAt,
    });
  }

  if (
    input.currentState ===
    GuestJourneyState.READY_FOR_ARRIVAL
  ) {
    return resolveExistingGuestJourneyIssue({
      context: input,
      issueCode:
        "GUEST_JOURNEY_READY_FOR_ARRIVAL",
      title:
        "Guest journey ready for arrival",
      issue:
        "Pin&Go confirmed that the guest journey is ready for arrival.",
      resolutionCode:
        "GUEST_READY_FOR_ARRIVAL",
      resolutionSummary:
        "Verification and guest access readiness were completed without host intervention.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",
      occurredAt,
    });
  }

  const monitoringAt =
    getMonitoringAt(input.checkIn);
  const criticalAt =
    getCriticalAt(input.checkIn);

  if (occurredAt < monitoringAt) {
    return resolveExistingGuestJourneyIssue({
      context: input,
      issueCode:
        "GUEST_JOURNEY_MONITORING_DEFERRED",
      title:
        "Guest journey monitoring deferred",
      issue:
        "The reservation moved outside the active pre-arrival monitoring window.",
      resolutionCode:
        "GUEST_JOURNEY_OUTSIDE_MONITORING_WINDOW",
      resolutionSummary:
        "Pin&Go closed the active journey workflow until the reservation re-enters the 24-hour monitoring window.",
      resolutionType: "SUPERSEDED",
      resolvedBy: "PIN_GO",
      occurredAt,
    });
  }

  if (
    input.currentState ===
    GuestJourneyState.VERIFICATION_PENDING
  ) {
    if (occurredAt >= criticalAt) {
      return upsertGuestJourneyActiveIssue({
        context: input,
        issueCode:
          "GUEST_VERIFICATION_HOST_ACTION_REQUIRED",
        title:
          "Guest verification requires attention",
        issue:
          `${input.guestName ?? "The guest"} has not completed secure pre-check-in within two hours of arrival at ${input.propertyName}.`,
        operationalImpact:
          "Pin&Go cannot release guest access until the required verification and agreement steps are complete.",
        recommendedAction:
          "Contact the guest and ensure secure pre-check-in is completed before arrival; decide how to handle the arrival if the requirement remains incomplete.",
        nextAutomaticStep: null,
        severity: "CRITICAL",
        workflowState:
          "ACTION_REQUIRED",
        responsibleActor: "HOST",
        canAutoResolve: false,
        autoResolveStatus:
          "NOT_SUPPORTED",
        nextAttemptAt: null,
        exhausted: true,
        occurredAt,
      });
    }

    return upsertGuestJourneyActiveIssue({
      context: input,
      issueCode:
        "GUEST_VERIFICATION_MONITORING",
      title:
        "Pin&Go is monitoring guest verification",
      issue:
        `${input.guestName ?? "The guest"} has not completed secure pre-check-in yet.`,
      operationalImpact:
        "Access remains safely blocked until the required verification and agreement steps are complete.",
      recommendedAction: null,
      nextAutomaticStep:
        `Pin&Go will continue monitoring verification and reassess the journey at ${criticalAt.toISOString()}.`,
      severity: "WARNING",
      workflowState: "WAITING",
      responsibleActor: "GUEST",
      canAutoResolve: true,
      autoResolveStatus: "AVAILABLE",
      nextAttemptAt: criticalAt,
      exhausted: false,
      occurredAt,
    });
  }

  if (
    input.currentState ===
    GuestJourneyState.VERIFICATION_COMPLETED
  ) {
    const accessWindowStarted =
      occurredAt >= criticalAt;

    return upsertGuestJourneyActiveIssue({
      context: input,
      issueCode: accessWindowStarted
        ? "GUEST_ACCESS_PREPARATION_RUNNING"
        : "GUEST_ACCESS_PREPARATION_SCHEDULED",
      title: accessWindowStarted
        ? "Pin&Go is preparing guest access"
        : "Guest access preparation is scheduled",
      issue:
        "Secure pre-check-in is complete and Pin&Go owns the next access step.",
      operationalImpact:
        "No host action is required while Access prepares the time-bound guest credential.",
      recommendedAction: null,
      nextAutomaticStep: accessWindowStarted
        ? "Pin&Go will create or verify the guest credential and mark the journey ready for arrival."
        : `Pin&Go will begin guest access preparation at ${criticalAt.toISOString()}.`,
      severity: "INFO",
      workflowState: accessWindowStarted
        ? "AUTO_RESOLVING"
        : "WAITING",
      responsibleActor: "PIN_GO",
      canAutoResolve: true,
      autoResolveStatus: accessWindowStarted
        ? "RUNNING"
        : "AVAILABLE",
      nextAttemptAt: accessWindowStarted
        ? null
        : criticalAt,
      exhausted: false,
      occurredAt,
    });
  }

  if (
    input.currentState ===
    GuestJourneyState.ACCESS_SCHEDULED
  ) {
    return upsertGuestJourneyActiveIssue({
      context: input,
      issueCode:
        "GUEST_ARRIVAL_READINESS_RUNNING",
      title:
        "Pin&Go is finalizing arrival readiness",
      issue:
        "Guest access is scheduled and Pin&Go is confirming the final arrival state.",
      operationalImpact:
        "No host action is required while Pin&Go verifies the credential lifecycle.",
      recommendedAction: null,
      nextAutomaticStep:
        "Pin&Go will confirm the access release and mark the guest journey ready for arrival.",
      severity: "INFO",
      workflowState: "AUTO_RESOLVING",
      responsibleActor: "PIN_GO",
      canAutoResolve: true,
      autoResolveStatus: "RUNNING",
      nextAttemptAt: null,
      exhausted: false,
      occurredAt,
    });
  }

  return upsertGuestJourneyActiveIssue({
    context: input,
    issueCode:
      "GUEST_JOURNEY_STATE_RECOVERY_RUNNING",
    title:
      "Pin&Go is reconciling the guest journey",
    issue:
      "The guest journey has not advanced from reservation confirmation yet.",
    operationalImpact:
      "Pin&Go is repairing the journey state before requesting any host action.",
    recommendedAction: null,
    nextAutomaticStep:
      "Pin&Go will advance the reservation into secure pre-check-in monitoring automatically.",
    severity: "WARNING",
    workflowState: "AUTO_RESOLVING",
    responsibleActor: "PIN_GO",
    canAutoResolve: true,
    autoResolveStatus: "RUNNING",
    nextAttemptAt: null,
    exhausted: false,
    occurredAt,
  });
}

export async function reconcileGuestJourneyOperationalIssues(
  prisma: PrismaClient,
  now: Date = new Date()
) {
  const monitoringThrough = new Date(
    now.getTime() + MONITORING_WINDOW_MS
  );

  const existingActiveIssues =
    await prisma.operationalIssue.findMany({
      where: {
        workflowState: {
          not: "RESOLVED",
        },
        reservationId: {
          not: null,
        },
        OR: [
          {
            engine: {
              in: [
                ...ACTIVE_ISSUE_ENGINE_NAMES,
              ],
            },
          },
          {
            issueCode: {
              startsWith:
                "GUEST_JOURNEY_",
            },
          },
          {
            issueCode: {
              startsWith:
                "GUEST_VERIFICATION_",
            },
          },
          {
            issueCode: {
              startsWith:
                "GUEST_ACCESS_PREPARATION_",
            },
          },
          {
            issueCode: {
              startsWith:
                "GUEST_ARRIVAL_READINESS_",
            },
          },
        ],
      },
      select: {
        reservationId: true,
      },
    });

  const existingIssueReservationIds =
    Array.from(
      new Set(
        existingActiveIssues
          .map((issue) =>
            String(
              issue.reservationId ?? ""
            ).trim()
          )
          .filter(Boolean)
      )
    );

  const journeys =
    await prisma.guestJourney.findMany({
      where: {
        OR: [
          {
            reservation: {
              is: {
                status:
                  ReservationStatus.ACTIVE,
                checkIn: {
                  lte: monitoringThrough,
                },
                checkOut: {
                  gt: now,
                },
              },
            },
          },
          ...(existingIssueReservationIds.length > 0
            ? [
                {
                  reservationId: {
                    in: existingIssueReservationIds,
                  },
                },
              ]
            : []),
        ],
      },
      orderBy: {
        stateChangedAt: "asc",
      },
      select: {
        id: true,
        reservationId: true,
        currentState: true,
        stateChangedAt: true,
        reservation: {
          select: {
            reservationNumber: true,
            guestName: true,
            status: true,
            checkIn: true,
            checkOut: true,
            guestAccessReleaseStatus: true,
            propertyId: true,
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

  let processed = 0;
  let stateRecoveries = 0;
  let hostActions = 0;
  let automaticWork = 0;
  let resolved = 0;
  let failed = 0;

  for (const journey of journeys) {
    try {
      let currentState =
        journey.currentState;

      if (
        currentState ===
          GuestJourneyState.RESERVATION_CONFIRMED &&
        journey.reservation.status ===
          ReservationStatus.ACTIVE
      ) {
        const recovery =
          await prisma.$transaction(
            (tx) =>
              ensureGuestJourneyForConfirmedReservation(
                tx,
                journey.reservationId
              )
          );

        currentState =
          recovery.currentState;

        if (recovery.transitioned) {
          stateRecoveries += 1;
        }
      }

      const result =
        await synchronizeGuestJourneyOperationalIssue({
          prisma,
          journeyId: journey.id,
          reservationId:
            journey.reservationId,
          reservationNumber:
            journey.reservation
              .reservationNumber,
          guestName:
            journey.reservation.guestName,
          organizationId:
            journey.reservation.property
              .organizationId,
          propertyId:
            journey.reservation.propertyId,
          propertyName:
            journey.reservation.property.name,
          reservationStatus:
            journey.reservation.status,
          checkIn:
            journey.reservation.checkIn,
          checkOut:
            journey.reservation.checkOut,
          currentState,
          stateChangedAt:
            journey.stateChangedAt,
          guestAccessReleaseStatus:
            journey.reservation
              .guestAccessReleaseStatus,
          occurredAt: now,
        });

      processed += 1;

      if (
        "workflowState" in result &&
        result.workflowState ===
          "ACTION_REQUIRED"
      ) {
        hostActions += 1;
      } else if (
        "workflowState" in result &&
        (result.workflowState ===
          "WAITING" ||
          result.workflowState ===
            "AUTO_RESOLVING")
      ) {
        automaticWork += 1;
      } else if (
        "workflowState" in result &&
        result.workflowState ===
          "RESOLVED"
      ) {
        resolved += 1;
      }
    } catch (error) {
      failed += 1;

      console.error(
        "[GUEST_JOURNEY_OPERATIONAL_RECONCILIATION_ERROR]",
        {
          journeyId: journey.id,
          reservationId:
            journey.reservationId,
          currentState:
            journey.currentState,
          error:
            error instanceof Error
              ? error.stack || error.message
              : String(error),
        }
      );
    }
  }

  return {
    processed,
    stateRecoveries,
    hostActions,
    automaticWork,
    resolved,
    failed,
  };
}
