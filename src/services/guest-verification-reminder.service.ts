import {
  GuestJourneyState,
  PrismaClient,
  ReminderKind,
  ReservationStatus,
} from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";
import {
  sendGuestVerificationReminderEmail,
} from "../lib/mailer";
import { sendLoggedEmail } from "./email-delivery.service";
import {
  resolveGuestLanguage,
  type GuestLanguage,
} from "./guest-language.service";
import { resolveOrganizationGuestReplyTo } from "./organization-guest-email.service";

export type SendGuestVerificationReminderResult = {
  reservationId: string;
  reminderStatus: "SENT" | "FAILED" | "SKIPPED";
  emailStatus: "SENT" | "FAILED" | "SKIPPED";
  smsStatus: "SENT" | "FAILED" | "SKIPPED";
  skippedReason?: string;
};

function getPublicApiUrl() {
  return String(
    process.env.PUBLIC_API_BASE_URL ??
      process.env.API_BASE_URL ??
      "http://localhost:3000"
  )
    .trim()
    .replace(/\/+$/, "");
}

function buildGuestVerificationUrl(
  guestToken: string
) {
  return (
    `${getPublicApiUrl()}/guest/verify/` +
    encodeURIComponent(guestToken)
  );
}

function hasGuestSmsConsent(
  externalRaw: unknown
): boolean {
  if (
    !externalRaw ||
    typeof externalRaw !== "object" ||
    Array.isArray(externalRaw)
  ) {
    return false;
  }

  const consent = (
    externalRaw as Record<string, unknown>
  ).consent;

  if (
    !consent ||
    typeof consent !== "object" ||
    Array.isArray(consent)
  ) {
    return false;
  }

  const consentRecord =
    consent as Record<string, unknown>;

  const acceptedAt = String(
    consentRecord.acceptedAt ?? ""
  ).trim();

  return (
    consentRecord.smsConsent === true &&
    acceptedAt.length > 0
  );
}

function maskVerificationUrl(
  verificationUrl: string
) {
  return verificationUrl.replace(
    /(\/guest\/verify\/)([^/?\s]+)/i,
    (_match, prefix, token) =>
      `${prefix}${String(token).slice(0, 4)}****`
  );
}

export function buildVerificationReminderSms(input: {
  guestName?: string | null;
  propertyName: string;
  reservationNumber: string;
  verificationUrl: string;
  language: GuestLanguage;
}) {
  const guestName =
    String(input.guestName ?? "").trim();

  const isSpanish = input.language === "es";
  const greeting = guestName
    ? `${isSpanish ? "Hola" : "Hi"} ${guestName},`
    : isSpanish
      ? "Hola,"
      : "Hi,";

  if (isSpanish) {
    return `${greeting}

Acción requerida para la reservación #${input.reservationNumber} en ${input.propertyName}.

Complete su registro seguro antes de que Pin&Go pueda entregar su acceso digital:

${input.verificationUrl}

Pin&Go Guest Services`;
  }

  return `${greeting}

Action required for reservation #${input.reservationNumber} at ${input.propertyName}.

Please complete your secure pre-check-in before Pin&Go can release your digital access:

${input.verificationUrl}

Pin&Go Guest Services`;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export async function sendGuestVerificationReminder(
  prisma: PrismaClient,
  reservationId: string
): Promise<SendGuestVerificationReminderResult> {
  const cleanReservationId =
    String(reservationId ?? "").trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  const reservation =
    await prisma.reservation.findUnique({
      where: {
        id: cleanReservationId,
      },
      select: {
        id: true,
        reservationNumber: true,
        status: true,
        checkIn: true,
        checkOut: true,
        guestName: true,
        guestEmail: true,
        guestPhone: true,
        preferredLanguage: true,
        guestToken: true,
        externalRaw: true,
        guestAgreementSnapshot: true,
        verificationStatus: true,
        guestJourney: {
          select: {
            currentState: true,
          },
        },
        property: {
          select: {
            id: true,
            organizationId: true,
            name: true,
            timezone: true,
          },
        },
      },
    });

  if (!reservation) {
    throw new Error(
      "GUEST_VERIFICATION_REMINDER_RESERVATION_NOT_FOUND"
    );
  }

  const language = resolveGuestLanguage(
    reservation.preferredLanguage
  );

  const guestAgreementSnapshot =
    reservation.guestAgreementSnapshot &&
    typeof reservation.guestAgreementSnapshot ===
      "object" &&
    !Array.isArray(
      reservation.guestAgreementSnapshot
    )
      ? (reservation.guestAgreementSnapshot as Record<
          string,
          unknown
        >)
      : null;

  const identityVerificationRequired =
    guestAgreementSnapshot
      ?.requiresIdentityVerification !== false;

  if (
    reservation.status !==
    ReservationStatus.ACTIVE
  ) {
    return {
      reservationId: reservation.id,
      reminderStatus: "SKIPPED",
      emailStatus: "SKIPPED",
      smsStatus: "SKIPPED",
      skippedReason:
        "RESERVATION_NOT_ACTIVE",
    };
  }

  if (
    reservation.guestJourney
      ?.currentState !==
    GuestJourneyState.VERIFICATION_PENDING
  ) {
    return {
      reservationId: reservation.id,
      reminderStatus: "SKIPPED",
      emailStatus: "SKIPPED",
      smsStatus: "SKIPPED",
      skippedReason:
        "GUEST_JOURNEY_NOT_VERIFICATION_PENDING",
    };
  }

  if (!identityVerificationRequired) {
    return {
      reservationId: reservation.id,
      reminderStatus: "SKIPPED",
      emailStatus: "SKIPPED",
      smsStatus: "SKIPPED",
      skippedReason:
        "IDENTITY_VERIFICATION_NOT_REQUIRED",
    };
  }

  if (
    reservation.verificationStatus ===
      "COMPLETED" ||
    reservation.verificationStatus ===
      "NOT_REQUIRED"
  ) {
    return {
      reservationId: reservation.id,
      reminderStatus: "SKIPPED",
      emailStatus: "SKIPPED",
      smsStatus: "SKIPPED",
      skippedReason:
        "GUEST_ALREADY_VERIFIED",
    };
  }

  if (!reservation.guestToken) {
    return {
      reservationId: reservation.id,
      reminderStatus: "FAILED",
      emailStatus: "SKIPPED",
      smsStatus: "SKIPPED",
      skippedReason:
        "GUEST_TOKEN_MISSING",
    };
  }

  const existingReminder =
    await prisma.guestLinkReminderLog.findUnique({
      where: {
        reservationId_kind: {
          reservationId: reservation.id,
          kind:
            ReminderKind.VERIFICATION_REMINDER,
        },
      },
      select: {
        status: true,
      },
    });

  if (existingReminder?.status === "SENT") {
    return {
      reservationId: reservation.id,
      reminderStatus: "SKIPPED",
      emailStatus: "SKIPPED",
      smsStatus: "SKIPPED",
      skippedReason:
        "VERIFICATION_REMINDER_ALREADY_SENT",
    };
  }

  const verificationUrl =
    buildGuestVerificationUrl(
      reservation.guestToken
    );

  let emailStatus:
    | "SENT"
    | "FAILED"
    | "SKIPPED" = "SKIPPED";

  let smsStatus:
    | "SENT"
    | "FAILED"
    | "SKIPPED" = "SKIPPED";

  const errors: string[] = [];

  if (reservation.guestEmail) {
    const guestReplyTo =
      await resolveOrganizationGuestReplyTo(
        prisma,
        reservation.property.organizationId
      );

    const subject =
      `${language === "es" ? "Acción requerida - Reservación" : "Action required - Reservation"} ` +
      `#${reservation.reservationNumber ?? "Pending"}`;

    const emailResult =
      await sendLoggedEmail({
        prisma,
        type:
          "GUEST_VERIFICATION_REMINDER",
        to: reservation.guestEmail,
        subject,
        reservationId:
          reservation.id,
        propertyId:
          reservation.property.id,
        organizationId:
          reservation.property.organizationId,

        // No guardar el token ni el URL seguro
        // dentro del payload de logs.
        retryPayload: {
          reservationNumber:
            reservation.reservationNumber,
          guestName:
            reservation.guestName,
          propertyName:
            reservation.property.name,
          checkIn:
            reservation.checkIn,
          propertyTimeZone:
            reservation.property.timezone,
          preferredLanguage: language,
        },

        send: () =>
          sendGuestVerificationReminderEmail({
            to:
              reservation.guestEmail!,
            replyTo: guestReplyTo.email,
            reservationNumber:
              reservation.reservationNumber ??
              "Pending",
            guestName:
              reservation.guestName,
            propertyName:
              reservation.property.name,
            checkIn:
              reservation.checkIn,
            propertyTimeZone:
              reservation.property.timezone,
            verificationUrl,
            preferredLanguage: language,
          }),
      });

    emailStatus =
      emailResult.status;

    if (!emailResult.ok) {
      errors.push(
        `EMAIL:${emailResult.error ?? emailResult.status}`
      );
    }
  }

  const smsAllowed =
    Boolean(reservation.guestPhone) &&
    hasGuestSmsConsent(
      reservation.externalRaw
    );

  if (smsAllowed) {
    const smsBody =
      buildVerificationReminderSms({
        guestName:
          reservation.guestName,
        propertyName:
          reservation.property.name,
        reservationNumber:
          reservation.reservationNumber ??
          "Pending",
        verificationUrl,
        language,
      });

    try {
      const sent =
        await sendSms(
          reservation.guestPhone!,
          smsBody
        );

      await prisma.messageLog.create({
        data: {
          channel: "sms",
          to:
            reservation.guestPhone!,
          from:
            process.env
              .TWILIO_FROM_NUMBER ??
            null,
          body:
            maskVerificationUrl(
              smsBody
            ),
          provider: "twilio",
          providerMessageId:
            (sent as any)?.sid ?? null,
          status: "SENT",
          reservationId:
            reservation.id,
          propertyId:
            reservation.property.id,
          organizationId:
            reservation.property
              .organizationId,
          communicationType:
            "GUEST_VERIFICATION_REMINDER",
        },
      });

      await prisma.messageDispatchLog.create({
        data: {
          reservationId:
            reservation.id,
          type:
            "GUEST_VERIFICATION_REMINDER",
          channel: "sms",
          status: "SENT",
        },
      });

      smsStatus = "SENT";
    } catch (error) {
      const errorMessage =
        toErrorMessage(error);

      errors.push(
        `SMS:${errorMessage}`
      );

      await prisma.messageLog
        .create({
          data: {
            channel: "sms",
            to:
              reservation.guestPhone!,
            from:
              process.env
                .TWILIO_FROM_NUMBER ??
              null,
            body:
              maskVerificationUrl(
                smsBody
              ),
            provider: "twilio",
            providerMessageId: null,
            status: "FAILED",
            error: errorMessage,
            reservationId:
              reservation.id,
            propertyId:
              reservation.property.id,
            organizationId:
              reservation.property
                .organizationId,
            communicationType:
              "GUEST_VERIFICATION_REMINDER",
          },
        })
        .catch(() => {});

      await prisma.messageDispatchLog
        .create({
          data: {
            reservationId:
              reservation.id,
            type:
              "GUEST_VERIFICATION_REMINDER",
            channel: "sms",
            status: "FAILED",
          },
        })
        .catch(() => {});

      smsStatus = "FAILED";
    }
  }

  const anyChannelSent =
    emailStatus === "SENT" ||
    smsStatus === "SENT";

  const noChannelAvailable =
    !reservation.guestEmail &&
    !smsAllowed;

  const reminderStatus =
    anyChannelSent
      ? "SENT"
      : noChannelAvailable
        ? "SKIPPED"
        : "FAILED";

  await prisma.guestLinkReminderLog.upsert({
    where: {
      reservationId_kind: {
        reservationId:
          reservation.id,
        kind:
          ReminderKind.VERIFICATION_REMINDER,
      },
    },
    create: {
      reservationId:
        reservation.id,
      kind:
        ReminderKind.VERIFICATION_REMINDER,
      channel:
        emailStatus === "SENT" &&
        smsStatus === "SENT"
          ? "email+sms"
          : emailStatus === "SENT"
            ? "email"
            : smsStatus === "SENT"
              ? "sms"
              : "none",
      to:
        reservation.guestEmail ??
        reservation.guestPhone ??
        "unavailable",
      provider:
        emailStatus === "SENT" &&
        smsStatus === "SENT"
          ? "resend+twilio"
          : emailStatus === "SENT"
            ? "resend"
            : smsStatus === "SENT"
              ? "twilio"
              : null,
      status:
        reminderStatus,
      error:
        errors.length > 0
          ? errors.join(" | ")
          : noChannelAvailable
            ? "NO_AVAILABLE_CHANNEL"
            : null,
    },
    update: {
      channel:
        emailStatus === "SENT" &&
        smsStatus === "SENT"
          ? "email+sms"
          : emailStatus === "SENT"
            ? "email"
            : smsStatus === "SENT"
              ? "sms"
              : "none",
      to:
        reservation.guestEmail ??
        reservation.guestPhone ??
        "unavailable",
      provider:
        emailStatus === "SENT" &&
        smsStatus === "SENT"
          ? "resend+twilio"
          : emailStatus === "SENT"
            ? "resend"
            : smsStatus === "SENT"
              ? "twilio"
              : null,
      status:
        reminderStatus,
      error:
        errors.length > 0
          ? errors.join(" | ")
          : noChannelAvailable
            ? "NO_AVAILABLE_CHANNEL"
            : null,
    },
  });

  return {
    reservationId:
      reservation.id,
    reminderStatus,
    emailStatus,
    smsStatus,
    ...(noChannelAvailable
      ? { skippedReason: "NO_AVAILABLE_CHANNEL" }
      : {}),
  };
}
