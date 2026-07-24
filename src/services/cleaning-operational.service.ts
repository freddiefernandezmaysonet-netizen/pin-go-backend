import {
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";

export type CleaningCoverageOperationalState =
  | "WAITING_FOR_CLEANER"
  | "BACKUP_ASSIGNED"
  | "DISPATCH_RETRY_SCHEDULED"
  | "NO_BACKUP_AVAILABLE"
  | "CONFIRMED"
  | "SUPERSEDED";

export type SynchronizeCleaningCoverageInput = {
  prisma: PrismaClient;
  reservationId: string;
  confirmationId?: string | null;
  staffMemberId?: string | null;
  state: CleaningCoverageOperationalState;
  attemptedCleanerCount?: number | null;
  nextAttemptAt?: Date | null;
  error?: string | null;
  reason?: string | null;
  occurredAt?: Date;
};

const MAX_ERROR_LENGTH = 8_000;

function buildOperationalKey(
  reservationId: string
) {
  return `CLEANING_COVERAGE:${reservationId}`;
}

function cleanText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeError(value: unknown) {
  const error = cleanText(value);
  return error
    ? error.slice(0, MAX_ERROR_LENGTH)
    : null;
}

async function loadCleaningContext(
  input: SynchronizeCleaningCoverageInput
) {
  const [reservation, cleaner] =
    await Promise.all([
      input.prisma.reservation.findUnique({
        where: {
          id: input.reservationId,
        },
        select: {
          id: true,
          reservationNumber: true,
          guestName: true,
          status: true,
          checkOut: true,
          propertyId: true,
          property: {
            select: {
              name: true,
              organizationId: true,
              cleaningNfcEnabled: true,
            },
          },
        },
      }),
      input.staffMemberId
        ? input.prisma.staffMember.findUnique({
            where: {
              id: input.staffMemberId,
            },
            select: {
              fullName: true,
            },
          })
        : null,
    ]);

  if (!reservation) {
    return null;
  }

  return {
    reservation,
    cleanerName:
      cleaner?.fullName ?? null,
  };
}

async function resolveExistingCleaningCoverage(
  input: SynchronizeCleaningCoverageInput & {
    issueCode: string;
    title: string;
    issue: string;
    resolutionCode: string;
    resolutionSummary: string;
    resolutionType:
      | "AUTOMATIC"
      | "SUPERSEDED";
    resolvedBy:
      | "PIN_GO"
      | "CLEANER"
      | "SYSTEM";
  },
  context: NonNullable<
    Awaited<
      ReturnType<
        typeof loadCleaningContext
      >
    >
  >,
  occurredAt: Date
) {
  const operationalKey =
    buildOperationalKey(
      input.reservationId
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
        "OPERATIONAL_ISSUE_NOT_FOUND" as const,
    };
  }

  const issue =
    await upsertOperationalIssue(
      input.prisma,
      {
        operationalKey,
        issueCode: input.issueCode,
        title: input.title,
        issue: input.issue,
        operationalImpact: null,
        recommendedAction: null,
        nextAutomaticStep: null,

        engine: "CLEANING",
        severity: "INFO",
        workflowState: "RESOLVED",
        visibility: "HOST",
        responsibleActor: "NONE",

        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "SUCCEEDED",
        autoResolveActionCode: null,

        organizationId:
          context.reservation.property
            .organizationId,
        propertyId:
          context.reservation.propertyId,
        reservationId:
          context.reservation.id,
        reservationNumber:
          context.reservation
            .reservationNumber,
        guestName:
          context.reservation.guestName,
        staffMemberId:
          input.staffMemberId ?? null,
        cleanerName:
          context.cleanerName,

        sourceType: "ENGINE_EVENT",

        resolvedAt: occurredAt,
        resolutionCode:
          input.resolutionCode,
        resolutionSummary:
          input.resolutionSummary,
        resolutionType:
          input.resolutionType,
        resolvedBy: input.resolvedBy,

        actionTarget: "CLEANING",

        metadata: {
          confirmationId:
            input.confirmationId ?? null,
          staffMemberId:
            input.staffMemberId ?? null,
          cleanerName:
            context.cleanerName,
          attemptedCleanerCount:
            input.attemptedCleanerCount ?? null,
          reason:
            cleanText(input.reason),
          propertyName:
            context.reservation.property.name,
          resolvedAt:
            occurredAt.toISOString(),
          exhausted: false,
        },

        transitionCode:
          input.resolutionCode,
        transitionSummary:
          input.resolutionSummary,
        transitionedBy:
          input.resolvedBy,
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

export async function synchronizeCleaningCoverageOperationalIssue(
  input: SynchronizeCleaningCoverageInput
) {
  const occurredAt =
    input.occurredAt ?? new Date();
  const context =
    await loadCleaningContext(input);

  if (!context) {
    return {
      applied: false as const,
      reason:
        "RESERVATION_NOT_FOUND" as const,
    };
  }

  const reservationSuperseded =
    context.reservation.status ===
      ReservationStatus.CANCELLED ||
    context.reservation.checkOut <=
      occurredAt ||
    context.reservation.property
      .cleaningNfcEnabled !== true;

  if (
    input.state === "SUPERSEDED" ||
    reservationSuperseded
  ) {
    return resolveExistingCleaningCoverage(
      {
        ...input,
        issueCode:
          "CLEANING_COVERAGE_SUPERSEDED",
        title:
          "Cleaning coverage workflow closed",
        issue:
          "Pin&Go closed cleaner coverage because the reservation no longer requires this workflow.",
        resolutionCode:
          "CLEANING_COVERAGE_NO_LONGER_REQUIRED",
        resolutionSummary:
          "Pin&Go closed cleaner coverage because the reservation ended, was cancelled, or cleaning NFC was disabled.",
        resolutionType: "SUPERSEDED",
        resolvedBy: "PIN_GO",
      },
      context,
      occurredAt
    );
  }

  if (input.state === "CONFIRMED") {
    return resolveExistingCleaningCoverage(
      {
        ...input,
        issueCode:
          "CLEANING_COVERAGE_CONFIRMED",
        title:
          "Cleaner coverage confirmed",
        issue:
          "The assigned cleaner confirmed availability for this turnover.",
        resolutionCode:
          "CLEANER_CONFIRMED_AVAILABILITY",
        resolutionSummary:
          "The cleaner confirmed availability and Pin&Go continued the turnover workflow without host intervention.",
        resolutionType: "AUTOMATIC",
        resolvedBy: "CLEANER",
      },
      context,
      occurredAt
    );
  }

  const operationalKey =
    buildOperationalKey(
      input.reservationId
    );

  if (
    input.state ===
    "NO_BACKUP_AVAILABLE"
  ) {
    const issue =
      await upsertOperationalIssue(
        input.prisma,
        {
          operationalKey,
          issueCode:
            "CLEANING_NO_BACKUP_AVAILABLE",
          title:
            "No cleaner is available for the turnover",
          issue:
            `Pin&Go exhausted the configured cleaner candidates for ${context.reservation.property.name}.`,
          operationalImpact:
            "The turnover currently has no confirmed cleaner.",
          recommendedAction:
            "Assign an available cleaner and confirm coverage for this turnover.",
          nextAutomaticStep: null,

          engine: "CLEANING",
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
            context.reservation.property
              .organizationId,
          propertyId:
            context.reservation.propertyId,
          reservationId:
            context.reservation.id,
          reservationNumber:
            context.reservation
              .reservationNumber,
          guestName:
            context.reservation.guestName,
          staffMemberId:
            input.staffMemberId ?? null,
          cleanerName:
            context.cleanerName,

          sourceType: "ENGINE_EVENT",
          actionTarget: "CLEANING",

          metadata: {
            confirmationId:
              input.confirmationId ?? null,
            staffMemberId:
              input.staffMemberId ?? null,
            cleanerName:
              context.cleanerName,
            attemptedCleanerCount:
              input.attemptedCleanerCount ?? null,
            nextAttemptAt: null,
            exhausted: true,
            reason:
              cleanText(input.reason) ??
              "NO_BACKUP_AVAILABLE",
            lastError:
              normalizeError(input.error),
            propertyName:
              context.reservation.property.name,
          },

          transitionCode:
            "CLEANING_COVERAGE_EXHAUSTED",
          transitionSummary:
            "Cleaning exhausted its automatic cleaner selection path and transferred responsibility to the host.",
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

  const issueCode =
    input.state === "BACKUP_ASSIGNED"
      ? "CLEANING_BACKUP_ASSIGNED"
      : input.state ===
        "DISPATCH_RETRY_SCHEDULED"
      ? "CLEANING_CONFIRMATION_DISPATCH_RETRY_SCHEDULED"
      : "CLEANING_CONFIRMATION_WAITING";

  const title =
    input.state === "BACKUP_ASSIGNED"
      ? "Pin&Go assigned a backup cleaner"
      : input.state ===
        "DISPATCH_RETRY_SCHEDULED"
      ? "Pin&Go is retrying the cleaner notification"
      : "Pin&Go is waiting for cleaner confirmation";

  const issueText =
    input.state === "BACKUP_ASSIGNED"
      ? `Pin&Go selected ${context.cleanerName ?? "the next available cleaner"} after the previous cleaner did not confirm coverage.`
      : input.state ===
        "DISPATCH_RETRY_SCHEDULED"
      ? "Pin&Go could not deliver the cleaner confirmation request and retained ownership of the retry workflow."
      : `Pin&Go requested turnover confirmation from ${context.cleanerName ?? "the assigned cleaner"}.`;

  const nextAutomaticStep =
    input.state ===
    "DISPATCH_RETRY_SCHEDULED"
      ? input.nextAttemptAt
        ? `Pin&Go will retry the cleaner notification at ${input.nextAttemptAt.toISOString()}.`
        : "Pin&Go will retry the cleaner notification automatically."
      : input.nextAttemptAt
      ? `If the cleaner does not confirm, Pin&Go will select the next available backup after ${input.nextAttemptAt.toISOString()}.`
      : "If the cleaner does not confirm, Pin&Go will continue the configured fallback workflow automatically.";

  const issue =
    await upsertOperationalIssue(
      input.prisma,
      {
        operationalKey,
        issueCode,
        title,
        issue: issueText,
        operationalImpact:
          "Cleaner coverage is not confirmed yet, but Pin&Go still has an automatic continuation path.",
        recommendedAction: null,
        nextAutomaticStep,

        engine: "CLEANING",
        severity: "INFO",
        workflowState: "WAITING",
        visibility: "HOST",
        responsibleActor: "PIN_GO",

        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "AVAILABLE",
        autoResolveActionCode:
          input.state ===
          "DISPATCH_RETRY_SCHEDULED"
            ? "RETRY_CLEANER_NOTIFICATION"
            : "SELECT_BACKUP_CLEANER",

        organizationId:
          context.reservation.property
            .organizationId,
        propertyId:
          context.reservation.propertyId,
        reservationId:
          context.reservation.id,
        reservationNumber:
          context.reservation
            .reservationNumber,
        guestName:
          context.reservation.guestName,
        staffMemberId:
          input.staffMemberId ?? null,
        cleanerName:
          context.cleanerName,

        sourceType: "ENGINE_EVENT",
        actionTarget: "CLEANING",

        metadata: {
          confirmationId:
            input.confirmationId ?? null,
          staffMemberId:
            input.staffMemberId ?? null,
          cleanerName:
            context.cleanerName,
          attemptedCleanerCount:
            input.attemptedCleanerCount ?? null,
          nextAttemptAt:
            input.nextAttemptAt
              ?.toISOString() ?? null,
          exhausted: false,
          reason:
            cleanText(input.reason),
          lastError:
            normalizeError(input.error),
          propertyName:
            context.reservation.property.name,
        },

        transitionCode:
          input.state === "BACKUP_ASSIGNED"
            ? "CLEANING_BACKUP_ASSIGNED"
            : input.state ===
              "DISPATCH_RETRY_SCHEDULED"
            ? "CLEANING_CONFIRMATION_DISPATCH_RETRY_SCHEDULED"
            : "CLEANING_CONFIRMATION_WAITING",
        transitionSummary:
          input.state === "BACKUP_ASSIGNED"
            ? "Cleaning selected a backup cleaner and retained ownership of confirmation coverage."
            : input.state ===
              "DISPATCH_RETRY_SCHEDULED"
            ? "Cleaning scheduled another automatic cleaner notification attempt."
            : "Cleaning is waiting for the assigned cleaner and will continue automatically if needed.",
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
