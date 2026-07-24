import {
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";

const MAX_ERROR_LENGTH = 8_000;

export type CommunicationChannel =
  | "sms"
  | "email";

export type CommunicationFailureKind =
  | "RETRYABLE"
  | "NON_RETRYABLE"
  | "RETRY_BUDGET_EXHAUSTED";

export type CommunicationOperationalContext = {
  prisma: PrismaClient;
  messageId: string;
  channel: CommunicationChannel;
  messageType: string;
  reservationId?: string | null;
  propertyId?: string | null;
  organizationId?: string | null;
  occurredAt?: Date;
};

function normalizeError(value: unknown) {
  const message =
    value instanceof Error
      ? value.stack || value.message
      : String(value ?? "");

  return message.slice(0, MAX_ERROR_LENGTH);
}

function buildOperationalKey(
  messageId: string
) {
  return `COMMUNICATION_DELIVERY:${messageId}`;
}

function getChannelLabel(
  channel: CommunicationChannel
) {
  return channel === "sms"
    ? "SMS"
    : "email";
}

function getRecommendedAction(
  channel: CommunicationChannel
) {
  return channel === "sms"
    ? "Verify the recipient phone number and use another communication channel if needed."
    : "Verify the recipient email address and use another communication channel if needed.";
}

async function loadCommunicationContext(
  input: CommunicationOperationalContext
) {
  const reservationId = String(
    input.reservationId ?? ""
  ).trim();

  const reservation = reservationId
    ? await input.prisma.reservation.findUnique({
        where: {
          id: reservationId,
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
            },
          },
        },
      })
    : null;

  return {
    reservation,
    organizationId:
      String(
        input.organizationId ??
          reservation?.property
            .organizationId ??
          ""
      ).trim() || null,
    propertyId:
      String(
        input.propertyId ??
          reservation?.propertyId ??
          ""
      ).trim() || null,
    propertyName:
      reservation?.property.name ??
      null,
  };
}

function isReservationOperational(
  reservation: {
    status: ReservationStatus;
    checkOut: Date;
  } | null,
  occurredAt: Date
) {
  if (!reservation) {
    return true;
  }

  return (
    reservation.status !==
      ReservationStatus.CANCELLED &&
    reservation.checkOut > occurredAt
  );
}

async function resolveExistingCommunicationIssue(
  input: CommunicationOperationalContext & {
    resolutionCode: string;
    resolutionSummary: string;
    resolutionType:
      | "AUTOMATIC"
      | "SUPERSEDED";
    resolvedBy: "PIN_GO" | "SYSTEM";
    retryCount?: number | null;
  }
) {
  const occurredAt =
    input.occurredAt ?? new Date();
  const operationalKey =
    buildOperationalKey(input.messageId);

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
    await loadCommunicationContext(input);
  const channelLabel =
    getChannelLabel(input.channel);

  const issue =
    await upsertOperationalIssue(
      input.prisma,
      {
        operationalKey,
        issueCode:
          input.resolutionType ===
          "SUPERSEDED"
            ? "COMMUNICATION_DELIVERY_SUPERSEDED"
            : "COMMUNICATION_DELIVERY_RECOVERED",
        title:
          input.resolutionType ===
          "SUPERSEDED"
            ? `${channelLabel} delivery workflow closed`
            : `${channelLabel} delivery recovered`,
        issue:
          input.resolutionType ===
          "SUPERSEDED"
            ? `Pin&Go closed the ${channelLabel} delivery workflow because the reservation is no longer operational.`
            : `Pin&Go delivered the ${channelLabel} message after automatic recovery.`,
        operationalImpact: null,
        recommendedAction: null,
        nextAutomaticStep: null,

        engine: "COMMUNICATIONS",
        severity: "INFO",
        workflowState: "RESOLVED",
        visibility: "SYSTEM",
        responsibleActor: "NONE",

        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "SUCCEEDED",
        autoResolveActionCode: null,

        organizationId:
          context.organizationId,
        propertyId: context.propertyId,
        reservationId:
          context.reservation?.id ?? null,
        reservationNumber:
          context.reservation
            ?.reservationNumber ?? null,
        guestName:
          context.reservation?.guestName ??
          null,

        sourceType: "WORKER",

        resolvedAt: occurredAt,
        resolutionCode:
          input.resolutionCode,
        resolutionSummary:
          input.resolutionSummary,
        resolutionType:
          input.resolutionType,
        resolvedBy: input.resolvedBy,

        actionTarget: "MESSAGING",

        metadata: {
          messageId: input.messageId,
          channel: input.channel,
          messageType: input.messageType,
          retryCount:
            input.retryCount ?? null,
          propertyName:
            context.propertyName,
          resolvedAt:
            occurredAt.toISOString(),
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
  };
}

export async function recordCommunicationDeliveryFailure(
  input: CommunicationOperationalContext & {
    retryCount: number;
    maxRetries: number;
    error: unknown;
    failureKind: CommunicationFailureKind;
    nextAttemptAt?: Date | null;
  }
) {
  const occurredAt =
    input.occurredAt ?? new Date();
  const context =
    await loadCommunicationContext(input);

  if (
    !isReservationOperational(
      context.reservation,
      occurredAt
    )
  ) {
    return resolveExistingCommunicationIssue({
      ...input,
      occurredAt,
      resolutionCode:
        "COMMUNICATION_RESERVATION_NO_LONGER_OPERATIONAL",
      resolutionSummary:
        "Pin&Go closed the delivery workflow because the reservation was cancelled or ended.",
      resolutionType: "SUPERSEDED",
      resolvedBy: "PIN_GO",
    });
  }

  const operationalKey =
    buildOperationalKey(input.messageId);
  const channelLabel =
    getChannelLabel(input.channel);
  const error = normalizeError(input.error);

  if (input.failureKind === "RETRYABLE") {
    const nextAutomaticStep =
      input.nextAttemptAt
        ? `Pin&Go will retry ${channelLabel} delivery at ${input.nextAttemptAt.toISOString()}.`
        : `Pin&Go will retry ${channelLabel} delivery automatically.`;

    const issue =
      await upsertOperationalIssue(
        input.prisma,
        {
          operationalKey,
          issueCode:
            input.channel === "sms"
              ? "COMMUNICATION_SMS_RETRY_SCHEDULED"
              : "COMMUNICATION_EMAIL_RETRY_SCHEDULED",
          title:
            `Pin&Go is retrying ${channelLabel} delivery`,
          issue:
            `Pin&Go could not deliver a ${channelLabel} message and retained ownership of the retry workflow.`,
          operationalImpact:
            "The intended recipient has not received the operational message yet.",
          recommendedAction: null,
          nextAutomaticStep,

          engine: "COMMUNICATIONS",
          severity: "WARNING",
          workflowState: "WAITING",
          visibility: "HOST",
          responsibleActor: "PIN_GO",

          actionRequired: false,
          canAutoResolve: true,
          autoResolveStatus: "AVAILABLE",
          autoResolveActionCode:
            "RETRY_MESSAGE_DELIVERY",

          organizationId:
            context.organizationId,
          propertyId:
            context.propertyId,
          reservationId:
            context.reservation?.id ?? null,
          reservationNumber:
            context.reservation
              ?.reservationNumber ?? null,
          guestName:
            context.reservation?.guestName ??
            null,

          sourceType: "WORKER",
          actionTarget: "MESSAGING",

          metadata: {
            messageId: input.messageId,
            channel: input.channel,
            messageType:
              input.messageType,
            attempt: input.retryCount,
            maxAttempts:
              input.maxRetries,
            nextAttemptAt:
              input.nextAttemptAt
                ?.toISOString() ?? null,
            exhausted: false,
            lastError: error,
            propertyName:
              context.propertyName,
          },

          transitionCode:
            "COMMUNICATION_RETRY_SCHEDULED",
          transitionSummary:
            `Communications scheduled automatic ${channelLabel} delivery attempt ${input.retryCount + 1} of ${input.maxRetries}.`,
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

  const nonRetryable =
    input.failureKind ===
    "NON_RETRYABLE";

  const issue =
    await upsertOperationalIssue(
      input.prisma,
      {
        operationalKey,
        issueCode: nonRetryable
          ? input.channel === "sms"
            ? "COMMUNICATION_SMS_DELIVERY_NON_RETRYABLE"
            : "COMMUNICATION_EMAIL_DELIVERY_NON_RETRYABLE"
          : input.channel === "sms"
          ? "COMMUNICATION_SMS_RETRY_EXHAUSTED"
          : "COMMUNICATION_EMAIL_RETRY_EXHAUSTED",
        title:
          `${channelLabel} delivery requires host action`,
        issue:
          nonRetryable
            ? `Pin&Go detected a ${channelLabel} delivery error that cannot be retried automatically.`
            : `Pin&Go exhausted ${input.maxRetries} automatic ${channelLabel} delivery attempts.`,
        operationalImpact:
          "The intended recipient did not receive the operational message.",
        recommendedAction:
          getRecommendedAction(input.channel),
        nextAutomaticStep: null,

        engine: "COMMUNICATIONS",
        severity:
          input.messageType ===
          "GUEST_ACCESS_PASSCODE"
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
          context.organizationId,
        propertyId: context.propertyId,
        reservationId:
          context.reservation?.id ?? null,
        reservationNumber:
          context.reservation
            ?.reservationNumber ?? null,
        guestName:
          context.reservation?.guestName ??
          null,

        sourceType: "WORKER",
        actionTarget: "MESSAGING",

        metadata: {
          messageId: input.messageId,
          channel: input.channel,
          messageType: input.messageType,
          attempt: input.retryCount,
          maxAttempts: input.maxRetries,
          nextAttemptAt: null,
          exhausted: true,
          failureKind:
            input.failureKind,
          lastError: error,
          propertyName:
            context.propertyName,
        },

        transitionCode: nonRetryable
          ? "COMMUNICATION_DELIVERY_NON_RETRYABLE"
          : "COMMUNICATION_RETRY_EXHAUSTED",
        transitionSummary: nonRetryable
          ? `Communications transferred responsibility to the host because ${channelLabel} delivery cannot be retried.`
          : `Communications exhausted its ${channelLabel} retry budget and transferred responsibility to the host.`,
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

export async function resolveCommunicationDeliveryIssue(
  input: CommunicationOperationalContext & {
    retryCount?: number | null;
  }
) {
  return resolveExistingCommunicationIssue({
    ...input,
    resolutionCode:
      "COMMUNICATION_DELIVERED_AFTER_RETRY",
    resolutionSummary:
      "Pin&Go delivered the message automatically after retrying.",
    resolutionType: "AUTOMATIC",
    resolvedBy: "PIN_GO",
  });
}
