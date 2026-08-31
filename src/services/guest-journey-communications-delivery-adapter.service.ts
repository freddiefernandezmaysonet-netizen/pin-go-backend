import { createHash } from "node:crypto";

import { PrismaClient, ReservationStatus } from "@prisma/client";

import { sendSms } from "../integrations/twilio/twilio.client";
import {
  sendDirectBookingGuestCancellationEmail,
  sendDirectBookingGuestConfirmation,
  sendDirectBookingHostCancellationNotification,
  sendDirectBookingHostNotification,
  sendGuestAccessPasscodeEmail,
  sendGuestVerificationReminderEmail,
  sendManualReservationGuestCancellationEmail,
  sendManualReservationGuestConfirmation,
} from "../lib/mailer";
import { decryptAccessCode } from "./access-code-crypto.service";
import { buildGuestLink } from "./guestToken";
import { resolveGuestLanguage } from "./guest-language.service";
import { buildVerificationReminderSms } from "./guest-verification-reminder.service";
import { buildGuestPasscodeSmsBody } from "./messaging.service";
import { resolveOrganizationGuestReplyTo } from "./organization-guest-email.service";
import type {
  ClaimedCommunicationIntent,
  CommunicationCompletion,
} from "./guest-journey-communications-owner-runtime.service";

type DeliveryDependencies = {
  sendSms: typeof sendSms;
  sendEmail: (input: {
    prisma: PrismaClient;
    type: string;
    to: string;
    retryPayload: Record<string, unknown>;
    reservationId: string;
    organizationId: string;
    propertyId: string;
  }) => Promise<unknown>;
};

const GUEST_DESTINATION_TYPES = new Set([
  "DIRECT_BOOKING_GUEST_CONFIRMATION",
  "MANUAL_RESERVATION_GUEST_CONFIRMATION",
  "MANUAL_RESERVATION_GUEST_CANCELLATION",
  "DIRECT_BOOKING_GUEST_CANCELLATION",
  "GUEST_ACCESS_PASSCODE",
  "GUEST_VERIFICATION_REMINDER",
  "PRECHECKIN",
  "CHECKOUT",
]);

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function parseEmailEnvelope(body: string): {
  type: string;
  retryPayload: Record<string, unknown>;
} | null {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.kind !== "PIN_GO_EMAIL_DELIVERY") return null;
    const type = clean(parsed.type);
    if (!type) return null;
    const retryPayload = parsed.retryPayload &&
      typeof parsed.retryPayload === "object" &&
      !Array.isArray(parsed.retryPayload)
      ? parsed.retryPayload as Record<string, unknown>
      : {};
    return { type, retryPayload };
  } catch {
    return null;
  }
}

function hashEvidence(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function datesMatch(value: unknown, current: Date): boolean {
  if (value === null || value === undefined || value === "") return true;
  const parsed = new Date(String(value));
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() === current.getTime();
}

async function defaultSendEmail(input: {
  prisma: PrismaClient;
  type: string;
  to: string;
  retryPayload: Record<string, unknown>;
  reservationId: string;
  organizationId: string;
  propertyId: string;
}): Promise<unknown> {
  const payload = { ...input.retryPayload, to: input.to } as any;

  switch (input.type) {
    case "DIRECT_BOOKING_GUEST_CONFIRMATION":
      return sendDirectBookingGuestConfirmation(payload);
    case "DIRECT_BOOKING_HOST_NOTIFICATION":
      return sendDirectBookingHostNotification(payload);
    case "MANUAL_RESERVATION_GUEST_CONFIRMATION":
      return sendManualReservationGuestConfirmation(payload);
    case "MANUAL_RESERVATION_GUEST_CANCELLATION":
      return sendManualReservationGuestCancellationEmail(payload);
    case "DIRECT_BOOKING_GUEST_CANCELLATION":
      return sendDirectBookingGuestCancellationEmail(payload);
    case "DIRECT_BOOKING_HOST_CANCELLATION":
      return sendDirectBookingHostCancellationNotification(payload);
    case "GUEST_VERIFICATION_REMINDER": {
      const reservation = await input.prisma.reservation.findFirst({
        where: {
          id: input.reservationId,
          propertyId: input.propertyId,
          property: { organizationId: input.organizationId },
        },
        select: { guestToken: true },
      });
      if (!reservation?.guestToken) {
        throw new Error("COMMUNICATION_VERIFICATION_TOKEN_MISSING");
      }
      const verifyUrl = buildGuestLink(reservation.guestToken)
        .replace("/guest/access/", "/guest/verify/");
      return sendGuestVerificationReminderEmail({
        ...payload,
        verifyUrl,
      });
    }
    case "GUEST_ACCESS_PASSCODE": {
      const accessGrantId = clean(input.retryPayload.accessGrantId);
      if (!accessGrantId) {
        throw new Error("COMMUNICATION_ACCESS_GRANT_ID_MISSING");
      }
      const grant = await input.prisma.accessGrant.findFirst({
        where: {
          id: accessGrantId,
          reservationId: input.reservationId,
          reservation: {
            propertyId: input.propertyId,
            property: { organizationId: input.organizationId },
          },
        },
        include: {
          secureAccessCode: true,
          reservation: {
            include: { property: true },
          },
        },
      });
      if (!grant?.secureAccessCode?.accessCodeEnc || !grant.reservation) {
        throw new Error("COMMUNICATION_ACCESS_EVIDENCE_MISSING");
      }
      const replyTo = await resolveOrganizationGuestReplyTo(
        input.prisma,
        input.organizationId
      );
      return sendGuestAccessPasscodeEmail({
        to: input.to,
        replyTo: replyTo.email,
        reservationNumber: grant.reservation.reservationNumber ?? "Pending",
        guestName: grant.reservation.guestName,
        propertyName: grant.reservation.property.name,
        passcode: decryptAccessCode(grant.secureAccessCode.accessCodeEnc),
        unlockKey: grant.unlockKey ?? "#",
        validFrom: grant.startsAt,
        validUntil: grant.endsAt,
        propertyTimeZone: grant.reservation.property.timezone,
        preferredLanguage: grant.reservation.preferredLanguage,
      });
    }
    default:
      throw new Error(`COMMUNICATION_EMAIL_TYPE_UNSUPPORTED:${input.type}`);
  }
}

const DEFAULT_DEPENDENCIES: DeliveryDependencies = {
  sendSms,
  sendEmail: defaultSendEmail,
};

export type CommunicationDeliveryAdapterResult = {
  providerCalls: 0 | 1;
  completion: CommunicationCompletion;
};

export async function executeGuestJourneyCommunicationDeliveryAdapter(
  prisma: PrismaClient,
  claim: ClaimedCommunicationIntent,
  options: {
    now?: Date;
    providerTimeoutMs?: number;
  } = {},
  dependencies: DeliveryDependencies = DEFAULT_DEPENDENCIES
): Promise<CommunicationDeliveryAdapterResult> {
  if (
    claim.targetEngine !== "COMMUNICATIONS" ||
    !["REQUEST_COMMUNICATION", "REQUEST_COMMUNICATION_RETRY"].includes(claim.intentType)
  ) {
    throw new Error("GUEST_JOURNEY_COMMUNICATIONS_ADAPTER_CONTRACT_MISMATCH");
  }

  const now = new Date(options.now ?? new Date());
  if (Number.isNaN(now.getTime())) {
    throw new Error("GUEST_JOURNEY_COMMUNICATIONS_ADAPTER_NOW_INVALID");
  }
  const providerTimeoutMs = options.providerTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 1) {
    throw new Error("GUEST_JOURNEY_COMMUNICATIONS_PROVIDER_TIMEOUT_INVALID");
  }

  const messageLogId = clean(claim.payload.messageLogId);
  const requestedType = clean(claim.payload.communicationType);
  const requestedChannel = clean(claim.payload.channel).toLowerCase();
  if (!messageLogId || !requestedType || !["email", "sms"].includes(requestedChannel)) {
    return {
      providerCalls: 0,
      completion: {
        kind: "WAITING_FOR_EVIDENCE",
        outcomeEvidenceFingerprint: claim.inputEvidenceFingerprint,
        errorCode: "COMMUNICATION_CORRELATION_EVIDENCE_MISSING",
        errorDetail: "A retry requires an exact messageLogId, communicationType and supported channel.",
        messageLogId: messageLogId || null,
        communicationType: requestedType || null,
        channel: requestedChannel || null,
      },
    };
  }

  const [reservation, message] = await Promise.all([
    prisma.reservation.findFirst({
      where: {
        id: claim.reservationId,
        propertyId: claim.propertyId,
        property: { organizationId: claim.organizationId },
      },
      select: {
        status: true,
        guestEmail: true,
        guestPhone: true,
        checkIn: true,
        checkOut: true,
        cancelledAt: true,
        guestName: true,
        reservationNumber: true,
        preferredLanguage: true,
        guestToken: true,
        property: {
          select: {
            name: true,
            timezone: true,
          },
        },
      },
    }),
    prisma.messageLog.findFirst({
      where: {
        id: messageLogId,
        reservationId: claim.reservationId,
        propertyId: claim.propertyId,
        organizationId: claim.organizationId,
        communicationType: requestedType,
        channel: requestedChannel,
      },
    }),
  ]);

  if (!reservation || !message) {
    throw new Error("COMMUNICATION_SCOPE_OR_MESSAGE_MISMATCH");
  }

  if (message.status === "SENT") {
    return {
      providerCalls: 0,
      completion: {
        kind: "SUCCEEDED",
        outcomeEvidenceFingerprint: hashEvidence({
          messageLogId,
          status: "SENT",
          providerMessageId: message.providerMessageId ?? null,
        }),
        messageLogId,
        communicationType: requestedType,
        channel: requestedChannel,
        deliveryStatus: "SENT",
      },
    };
  }

  if (message.status === "E7_SENDING") {
    return {
      providerCalls: 0,
      completion: {
        kind: "WAITING_FOR_EVIDENCE",
        outcomeEvidenceFingerprint: hashEvidence({ messageLogId, status: message.status }),
        errorCode: "COMMUNICATION_PROVIDER_OUTCOME_UNKNOWN",
        errorDetail: "A previous fenced attempt reached the provider boundary; automatic replay is blocked to prevent duplicates.",
        messageLogId,
        communicationType: requestedType,
        channel: requestedChannel,
      },
    };
  }

  if (clean(message.status).toUpperCase() === "FAILED_FINAL") {
    return {
      providerCalls: 0,
      completion: {
        kind: "RETRYABLE",
        outcomeEvidenceFingerprint: hashEvidence({ messageLogId, status: message.status }),
        errorCode: "COMMUNICATION_LEGACY_FINAL_FAILURE",
        errorDetail: "The legacy retry worker marked this delivery final; E7 will escalate without replaying it.",
        messageLogId,
        communicationType: requestedType,
        channel: requestedChannel,
      },
    };
  }

  const normalizedMessageStatus = clean(message.status).toUpperCase();
  const expectedOwnedStatus =
    claim.intentType === "REQUEST_COMMUNICATION"
      ? "APMS_PENDING"
      : "FAILED";

  if (normalizedMessageStatus !== expectedOwnedStatus) {
    return {
      providerCalls: 0,
      completion: {
        kind: "WAITING_FOR_EVIDENCE",
        outcomeEvidenceFingerprint: hashEvidence({ messageLogId, status: message.status }),
        errorCode:
          claim.intentType === "REQUEST_COMMUNICATION"
            ? "COMMUNICATION_NOT_PENDING"
            : "COMMUNICATION_NOT_RETRYABLE",
        errorDetail:
          `The correlated message has status ${message.status ?? "UNKNOWN"}; ${claim.intentType} requires ${expectedOwnedStatus}.`,
        messageLogId,
        communicationType: requestedType,
        channel: requestedChannel,
      },
    };
  }

  const envelope = requestedChannel === "email" ? parseEmailEnvelope(message.body) : null;
  if (requestedChannel === "email" && (!envelope || envelope.type !== requestedType)) {
    throw new Error("COMMUNICATION_EMAIL_ENVELOPE_MISMATCH");
  }
  const retryPayload = envelope?.retryPayload ?? {};

  const cancellationMessage = requestedType.includes("CANCELLATION");
  const reservationCancelled = reservation.status === ReservationStatus.CANCELLED || Boolean(reservation.cancelledAt);
  const obsolete =
    (reservationCancelled && !cancellationMessage) ||
    (!reservationCancelled && cancellationMessage) ||
    !datesMatch(retryPayload.checkIn, reservation.checkIn) ||
    !datesMatch(retryPayload.checkOut, reservation.checkOut) ||
    (requestedType === "PRECHECKIN" && now >= reservation.checkIn) ||
    (requestedType === "CHECKOUT" && now < reservation.checkOut);

  if (obsolete) {
    await prisma.messageLog.updateMany({
      where: { id: message.id, status: message.status },
      data: {
        status: "OBSOLETE",
        error: "Superseded by current reservation evidence",
      },
    });
    return {
      providerCalls: 0,
      completion: {
        kind: "SUCCEEDED",
        outcomeEvidenceFingerprint: hashEvidence({ messageLogId, status: "OBSOLETE" }),
        messageLogId,
        communicationType: requestedType,
        channel: requestedChannel,
        deliveryStatus: "OBSOLETE",
      },
    };
  }

  if (GUEST_DESTINATION_TYPES.has(requestedType)) {
    const expectedDestination = requestedChannel === "email"
      ? clean(reservation.guestEmail).toLowerCase()
      : clean(reservation.guestPhone);
    const actualDestination = requestedChannel === "email"
      ? clean(message.to).toLowerCase()
      : clean(message.to);
    if (!expectedDestination || expectedDestination !== actualDestination) {
      throw new Error("COMMUNICATION_RECIPIENT_CHANGED_OR_INVALID");
    }
  }

  const fenced = await prisma.messageLog.updateMany({
    where: {
      id: message.id,
      status: message.status,
      retryCount: message.retryCount,
    },
    data: { status: "E7_SENDING" },
  });
  if (fenced.count !== 1) {
    throw new Error("COMMUNICATION_DELIVERY_FENCE_LOST");
  }

  const currentReservation = await prisma.reservation.findFirst({
    where: {
      id: claim.reservationId,
      propertyId: claim.propertyId,
      property: { organizationId: claim.organizationId },
    },
    select: {
      status: true,
      cancelledAt: true,
      guestEmail: true,
      guestPhone: true,
      checkIn: true,
      checkOut: true,
    },
  });
  if (!currentReservation) {
    await prisma.messageLog.updateMany({
      where: { id: message.id, status: "E7_SENDING" },
      data: { status: "FAILED", error: "Tenant canary changed before provider call" },
    });
    throw new Error("COMMUNICATION_CANARY_CHANGED_BEFORE_SEND");
  }
  const currentCancelled =
    currentReservation.status === ReservationStatus.CANCELLED ||
    Boolean(currentReservation.cancelledAt);
  const currentDestination = requestedChannel === "email"
    ? clean(currentReservation.guestEmail).toLowerCase()
    : clean(currentReservation.guestPhone);
  const originalDestination = requestedChannel === "email"
    ? clean(message.to).toLowerCase()
    : clean(message.to);
  const changedBeforeSend =
    currentReservation.checkIn.getTime() !== reservation.checkIn.getTime() ||
    currentReservation.checkOut.getTime() !== reservation.checkOut.getTime() ||
    currentCancelled !== reservationCancelled ||
    (GUEST_DESTINATION_TYPES.has(requestedType) &&
      currentDestination !== originalDestination);
  if (changedBeforeSend) {
    await prisma.messageLog.updateMany({
      where: { id: message.id, status: "E7_SENDING" },
      data: {
        status: "OBSOLETE",
        error: "Reservation or recipient changed before provider call",
      },
    });
    return {
      providerCalls: 0,
      completion: {
        kind: "SUCCEEDED",
        outcomeEvidenceFingerprint: hashEvidence({ messageLogId, status: "OBSOLETE" }),
        messageLogId,
        communicationType: requestedType,
        channel: requestedChannel,
        deliveryStatus: "OBSOLETE",
      },
    };
  }

  let smsBody = message.body;
  if (requestedChannel === "sms" && requestedType === "GUEST_ACCESS_PASSCODE") {
    const accessGrantId = clean(message.accessGrantId);
    const grant = accessGrantId
      ? await prisma.accessGrant.findFirst({
          where: {
            id: accessGrantId,
            reservationId: claim.reservationId,
            reservation: {
              propertyId: claim.propertyId,
              property: { organizationId: claim.organizationId },
            },
          },
          include: {
            secureAccessCode: true,
            reservation: {
              include: { property: true },
            },
          },
        })
      : null;
    if (!grant?.secureAccessCode?.accessCodeEnc || !grant.reservation) {
      throw new Error("COMMUNICATION_ACCESS_EVIDENCE_MISSING");
    }
    smsBody = buildGuestPasscodeSmsBody({
      guestName: grant.reservation.guestName,
      code: decryptAccessCode(grant.secureAccessCode.accessCodeEnc),
      validUntil: grant.endsAt,
      ...(grant.reservation.property.timezone
        ? { timezone: grant.reservation.property.timezone }
        : {}),
      language: resolveGuestLanguage(grant.reservation.preferredLanguage),
    });
  } else if (
    requestedChannel === "sms" &&
    requestedType === "GUEST_VERIFICATION_REMINDER"
  ) {
    if (!reservation.guestToken) {
      throw new Error("COMMUNICATION_VERIFICATION_TOKEN_MISSING");
    }
    smsBody = buildVerificationReminderSms({
      guestName: reservation.guestName,
      propertyName: reservation.property.name,
      reservationNumber: reservation.reservationNumber ?? "Pending",
      verificationUrl: buildGuestLink(reservation.guestToken)
        .replace("/guest/access/", "/guest/verify/"),
      language: resolveGuestLanguage(reservation.preferredLanguage),
    });
  } else if (
    requestedChannel === "sms" &&
    /FAILED BEFORE LOG BODY|\*{4}/i.test(smsBody)
  ) {
    throw new Error("COMMUNICATION_SMS_BODY_NOT_REPLAYABLE");
  }

  let providerResult: any;
  try {
    const providerPromise = requestedChannel === "sms"
      ? dependencies.sendSms(message.to, smsBody)
      : dependencies.sendEmail({
          prisma,
          type: requestedType,
          to: message.to,
          retryPayload,
          reservationId: claim.reservationId,
          organizationId: claim.organizationId,
          propertyId: claim.propertyId,
        });
    providerResult = await Promise.race([
      providerPromise,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("COMMUNICATION_PROVIDER_TIMEOUT")),
        providerTimeoutMs
      )),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await prisma.messageLog.updateMany({
      where: { id: message.id, status: "E7_SENDING" },
      data: {
        status: detail === "COMMUNICATION_PROVIDER_TIMEOUT" ? "E7_SENDING" : "FAILED",
        retryCount: { increment: 1 },
        error: detail,
      },
    });
    if (detail === "COMMUNICATION_PROVIDER_TIMEOUT") {
      return {
        providerCalls: 1,
        completion: {
          kind: "WAITING_FOR_EVIDENCE",
          outcomeEvidenceFingerprint: hashEvidence({ messageLogId, status: "E7_SENDING" }),
          errorCode: "COMMUNICATION_PROVIDER_OUTCOME_UNKNOWN",
          errorDetail: "The provider timed out after accepting the request boundary; replay is blocked to prevent duplicates.",
          messageLogId,
          communicationType: requestedType,
          channel: requestedChannel,
        },
      };
    }
    throw error;
  }

  const providerMessageId = providerResult?.sid ?? providerResult?.data?.id ??
    providerResult?.providerMessageId ?? providerResult?.id ?? null;
  const persisted = await prisma.messageLog.updateMany({
    where: { id: message.id, status: "E7_SENDING" },
    data: {
      status: "SENT",
      providerMessageId,
      retryCount: { increment: 1 },
      error: null,
    },
  });
  if (persisted.count !== 1) {
    throw new Error("COMMUNICATION_DELIVERY_RESULT_PERSISTENCE_LOST");
  }

  return {
    providerCalls: 1,
    completion: {
      kind: "SUCCEEDED",
      outcomeEvidenceFingerprint: hashEvidence({
        messageLogId,
        status: "SENT",
        providerMessageId: providerMessageId ?? null,
      }),
      messageLogId,
      communicationType: requestedType,
      channel: requestedChannel,
      deliveryStatus: "SENT",
    },
  };
}
