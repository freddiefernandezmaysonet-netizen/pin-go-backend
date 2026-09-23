import dotenv from "dotenv";
dotenv.config({ path: "./.env", override: true });

import { prisma } from "../lib/prisma";
import { sendSms } from "../integrations/twilio/twilio.client";
import {
  decryptAccessCode,
} from "../services/access-code-crypto.service";

import {
  sendGuestAccessPasscodeEmail,
  sendManualReservationGuestCancellationEmail,
  sendPropertyProtectionGuestClosureNotice,
  sendPropertyProtectionGuestDamageNotice,
  sendPropertyProtectionHostGuestResponseNotice,
} from "../lib/mailer";
import { resolveOrganizationGuestReplyTo } from "../services/organization-guest-email.service";
import {
  isGuestJourneyCommunicationsOwnerScope,
  resolveGuestJourneyCommunicationsOwnerConfig,
} from "../services/guest-journey-communications-owner.config";
import { evaluateCheckoutSmsConsent } from "../services/checkout-sms-consent.policy";

const WORKER_NAME = "message.retry.worker";
const POLL_MS = Number(process.env.MESSAGE_RETRY_POLL_MS ?? 30000);
const MAX_RETRIES = Number(process.env.MESSAGE_MAX_RETRIES ?? 3);
const BATCH_SIZE = Number(process.env.MESSAGE_RETRY_BATCH_SIZE ?? 20);
const GUEST_JOURNEY_COMMUNICATIONS_OWNER_CONFIG =
  resolveGuestJourneyCommunicationsOwnerConfig();

function yieldsToGuestJourneyCommunicationsOwner(message: {
  organizationId?: string | null;
  propertyId?: string | null;
  communicationType?: string | null;
}): boolean {
  return isGuestJourneyCommunicationsOwnerScope(
    GUEST_JOURNEY_COMMUNICATIONS_OWNER_CONFIG,
    message
  );
}

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}] [${WORKER_NAME}]`, ...args);
}

function errLog(...args: any[]) {
  console.error(`[${new Date().toISOString()}] [${WORKER_NAME}]`, ...args);
}

function toErrString(e: unknown) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function parseGuestAccessEmailRetryPayload(
  body: string
): {
  accessGrantId: string;
} | null {
  try {
    const parsed = JSON.parse(body);

    if (
      parsed?.kind !==
        "PIN_GO_EMAIL_DELIVERY" ||
      parsed?.type !==
        "GUEST_ACCESS_PASSCODE"
    ) {
      return null;
    }

    const accessGrantId = String(
      parsed?.retryPayload
        ?.accessGrantId ?? ""
    ).trim();

    if (!accessGrantId) {
      return null;
    }

    return {
      accessGrantId,
    };
  } catch {
    return null;
  }
}

function isNonRetryableAccessEmailError(
  value: unknown
) {
  const error = String(
    value ?? ""
  ).toUpperCase();

  return (
    error.includes(
      "GUEST_ACCESS_EMAIL_RETRY_PAYLOAD_MISSING"
    ) ||
    error.includes(
      "GUEST_ACCESS_GRANT_NOT_FOUND"
    ) ||
    error.includes(
      "GUEST_ACCESS_CODE_NOT_FOUND"
    ) ||
    error.includes(
      "GUEST_ACCESS_CODE_ENCRYPTED_VALUE_MISSING"
    ) ||
    error.includes(
      "GUEST_ACCESS_RESERVATION_NOT_FOUND"
    ) ||
    error.includes(
      "GUEST_ACCESS_EMAIL_DESTINATION_MISSING"
    )
  );
}

function isNonRetryableManualCancellationEmailError(
  value: unknown
) {
  const error = String(value ?? "").toUpperCase();

  return (
    error.includes("MANUAL_CANCELLATION_RESERVATION_ID_MISSING") ||
    error.includes("MANUAL_CANCELLATION_RESERVATION_NOT_FOUND") ||
    error.includes("MANUAL_CANCELLATION_RESERVATION_SCOPE_INVALID") ||
    error.includes("MANUAL_CANCELLATION_EMAIL_DESTINATION_MISSING")
  );
}

function isNonRetryableSmsError(value: unknown) {
  const error = String(value ?? "").toLowerCase();

  return (
    error.includes("not a valid phone number") ||
    error.includes("invalid phone number") ||
    error.includes("invalid 'to' phone number") ||
    error.includes("unable to create record") ||
    error.includes("the 'to' number") ||
    error.includes("is not a valid") ||
    error.includes("not sms capable") ||
    error.includes("not a mobile number") ||
    error.includes("landline") ||
    error.includes("unsubscribed") ||
    error.includes("blacklisted") ||
    error.includes("recipient is unable to receive") ||
    error.includes("destination phone number") ||
    error.includes("twilio error 21211") ||
    error.includes("twilio error 21614") ||
    error.includes("21211") ||
    error.includes("21614")
  );
}

async function processRetries() {
  const failedSmsMessages = await prisma.messageLog.findMany({
    where: {
      channel: "sms",
      status: "FAILED",
      retryCount: { lt: MAX_RETRIES },
    },
    take: BATCH_SIZE,
    orderBy: { createdAt: "asc" },
  });

  if (failedSmsMessages.length === 0) return;

  log("Retry batch", {
    channel: "sms",
    count: failedSmsMessages.length,
  });

  for (const msg of failedSmsMessages) {
    try {
      if (yieldsToGuestJourneyCommunicationsOwner(msg)) {
        log("SMS retry yielded to Guest Journey COMMUNICATIONS owner", {
          id: msg.id,
          communicationType: msg.communicationType,
        });
        continue;
      }
      if (String(msg.communicationType ?? "").toUpperCase() === "CHECKOUT") {
        const reservationId = String(msg.reservationId ?? "").trim();

        if (!reservationId) {
          await prisma.messageLog.update({
            where: { id: msg.id },
            data: {
              status: "FAILED_FINAL",
              error: "CHECKOUT_SMS_RESERVATION_ID_MISSING",
            },
          });
          continue;
        }

        const reservation = await prisma.reservation.findUnique({
          where: { id: reservationId },
          select: { externalRaw: true },
        });

        if (!reservation) {
          await prisma.messageLog.update({
            where: { id: msg.id },
            data: {
              status: "FAILED_FINAL",
              error: "CHECKOUT_SMS_RESERVATION_NOT_FOUND",
            },
          });
          continue;
        }

        const consentDecision = evaluateCheckoutSmsConsent(
          reservation.externalRaw
        );

        if (!consentDecision.allowed) {
          await prisma.messageLog.update({
            where: { id: msg.id },
            data: {
              status: "FAILED_FINAL",
              error: consentDecision.reason,
            },
          });

          log("Checkout SMS retry blocked", {
            id: msg.id,
            reservationId,
            reason: consentDecision.reason,
          });
          continue;
        }
      }

      log("Retrying SMS message", {
        id: msg.id,
        to: msg.to,
        channel: msg.channel,
        retryCount: msg.retryCount,
      });

      if (isNonRetryableSmsError(msg.error)) {
        await prisma.messageLog.update({
          where: { id: msg.id },
          data: {
            status: "FAILED_FINAL",
            error: msg.error ?? "Non-retryable SMS delivery error",
          },
        });

        errLog("SMS retry stopped: non-retryable error", {
          id: msg.id,
          to: msg.to,
          retryCount: msg.retryCount,
          error: msg.error,
        });

        continue;
      }

      const sent = await sendSms(msg.to, msg.body);

      await prisma.messageLog.update({
        where: { id: msg.id },
        data: {
          status: "SENT",
          providerMessageId: (sent as any)?.sid ?? null,
          retryCount: { increment: 1 },
          error: null,
        },
      });

      log("SMS retry success", {
        id: msg.id,
        sid: (sent as any)?.sid ?? null,
      });
    } catch (e) {
      const err = toErrString(e);
      const nonRetryable = isNonRetryableSmsError(err);

      try {
        await prisma.messageLog.update({
          where: { id: msg.id },
          data: {
            status: nonRetryable ? "FAILED_FINAL" : "FAILED",
            retryCount: { increment: 1 },
            error: err,
          },
        });
      } catch (updateErr) {
        errLog("SMS retry update failed", {
          id: msg.id,
          err: toErrString(updateErr),
        });
      }

      if (nonRetryable) {
        errLog("SMS retry stopped after non-retryable Twilio error", {
          id: msg.id,
          to: msg.to,
          err,
        });
      } else {
        errLog("SMS retry failed", {
          id: msg.id,
          err,
        });
      }
    }
  }
}

async function processGuestAccessEmailRetries() {
  const failedEmailMessages =
    await prisma.messageLog.findMany({
      where: {
        channel: "email",
        provider: "resend",
        status: "FAILED",
        retryCount: {
          lt: MAX_RETRIES,
        },
        body: {
          contains:
            '"type":"GUEST_ACCESS_PASSCODE"',
        },
      },
      take: BATCH_SIZE,
      orderBy: {
        createdAt: "asc",
      },
    });

  if (
    failedEmailMessages.length === 0
  ) {
    return;
  }

  log("Retry batch", {
    channel: "email",
    type: "GUEST_ACCESS_PASSCODE",
    count:
      failedEmailMessages.length,
  });

  for (
    const message of
    failedEmailMessages
  ) {
    try {
      if (yieldsToGuestJourneyCommunicationsOwner(message)) {
        log("Email retry yielded to Guest Journey COMMUNICATIONS owner", {
          id: message.id,
          communicationType: message.communicationType,
        });
        continue;
      }
      const retryPayload =
        parseGuestAccessEmailRetryPayload(
          message.body
        );

      if (!retryPayload) {
        throw new Error(
          "GUEST_ACCESS_EMAIL_RETRY_PAYLOAD_MISSING"
        );
      }

      const grant =
        await prisma.accessGrant.findUnique({
          where: {
            id: retryPayload.accessGrantId,
          },
          include: {
            secureAccessCode: true,
            reservation: {
              include: {
                property: {
                  select: {
                    id: true,
                    organizationId: true,
                    name: true,
                    timezone: true,
                  },
                },
              },
            },
          },
        });

      if (!grant) {
        throw new Error(
          "GUEST_ACCESS_GRANT_NOT_FOUND"
        );
      }

      if (!grant.secureAccessCode) {
        throw new Error(
          "GUEST_ACCESS_CODE_NOT_FOUND"
        );
      }

      if (
        !grant.secureAccessCode
          .accessCodeEnc
      ) {
        throw new Error(
          "GUEST_ACCESS_CODE_ENCRYPTED_VALUE_MISSING"
        );
      }

      if (!grant.reservation) {
        throw new Error(
          "GUEST_ACCESS_RESERVATION_NOT_FOUND"
        );
      }

      const guestEmail = String(
        grant.reservation.guestEmail ??
          ""
      ).trim();

      if (!guestEmail) {
        throw new Error(
          "GUEST_ACCESS_EMAIL_DESTINATION_MISSING"
        );
      }

      const passcode =
        decryptAccessCode(
          grant.secureAccessCode
            .accessCodeEnc
        );

      const reservationNumber =
        grant.reservation
          .reservationNumber ??
        "Pending";

      const guestReplyTo =
        await resolveOrganizationGuestReplyTo(
          prisma,
          grant.reservation.property
            .organizationId
        );

      const sent =
        await sendGuestAccessPasscodeEmail({
          to: guestEmail,
          replyTo: guestReplyTo.email,
          reservationNumber,
          guestName:
            grant.reservation.guestName,
          propertyName:
            grant.reservation.property
              .name,
          passcode,
          unlockKey:
            grant.unlockKey ?? "#",
          validFrom:
            grant.startsAt,
          validUntil:
            grant.endsAt,
          propertyTimeZone:
            grant.reservation.property
              .timezone,
          preferredLanguage:
            grant.reservation.preferredLanguage,
        });

      const providerMessageId =
        (sent as any)?.data?.id ??
        (sent as any)?.id ??
        null;

      await prisma.messageLog.update({
        where: {
          id: message.id,
        },
        data: {
          status: "SENT",
          providerMessageId,
          retryCount: {
            increment: 1,
          },
          error: null,
        },
      });

      try {
        await prisma.messageDispatchLog.create({
          data: {
            reservationId:
              grant.reservation.id,
            type:
              "GUEST_ACCESS_PASSCODE",
            channel: "email",
            status: "SENT",
          },
        });
      } catch (dispatchLogError) {
        errLog(
          "Email retry dispatch log failed",
          {
            messageId: message.id,
            reservationNumber:
              grant.reservation
                .reservationNumber ??
              null,
            error:
              toErrString(
                dispatchLogError
              ),
          }
        );
      }

      await prisma.reservation.update({
        where: {
          id: grant.reservation.id,
        },
        data: {
          guestAccessReleaseLastError:
            null,
        },
      });

      log(
        "Guest access email retry success",
        {
          messageId: message.id,
          reservationNumber:
            grant.reservation
              .reservationNumber ??
            null,
          retryCount:
            message.retryCount + 1,
        }
      );
    } catch (error) {
      const errorMessage =
        toErrString(error);

      const nextRetryCount =
        message.retryCount + 1;

      const nonRetryable =
        isNonRetryableAccessEmailError(
          errorMessage
        );

      const finalFailure =
        nonRetryable ||
        nextRetryCount >= MAX_RETRIES;

      try {
        await prisma.messageLog.update({
          where: {
            id: message.id,
          },
          data: {
            status: finalFailure
              ? "FAILED_FINAL"
              : "FAILED",
            retryCount: {
              increment: 1,
            },
            error: errorMessage,
          },
        });
      } catch (updateError) {
        errLog(
          "Guest access email retry update failed",
          {
            messageId: message.id,
            error:
              toErrString(updateError),
          }
        );
      }

      errLog(
        finalFailure
          ? "Guest access email retry stopped"
          : "Guest access email retry failed",
        {
          messageId: message.id,
          retryCount: nextRetryCount,
          error: errorMessage,
        }
      );
    }
  }
}

async function processManualCancellationEmailRetries() {
  const failedEmailMessages = await prisma.messageLog.findMany({
    where: {
      channel: "email",
      provider: "resend",
      status: "FAILED",
      retryCount: {
        lt: MAX_RETRIES,
      },
      body: {
        contains: '"type":"MANUAL_RESERVATION_GUEST_CANCELLATION"',
      },
    },
    take: BATCH_SIZE,
    orderBy: {
      createdAt: "asc",
    },
  });

  if (failedEmailMessages.length === 0) {
    return;
  }

  log("Retry batch", {
    channel: "email",
    type: "MANUAL_RESERVATION_GUEST_CANCELLATION",
    count: failedEmailMessages.length,
  });

  for (const message of failedEmailMessages) {
    try {
      if (yieldsToGuestJourneyCommunicationsOwner(message)) {
        log("Email retry yielded to Guest Journey COMMUNICATIONS owner", {
          id: message.id,
          communicationType: message.communicationType,
        });
        continue;
      }
      const reservationId = String(message.reservationId ?? "").trim();

      if (!reservationId) {
        throw new Error("MANUAL_CANCELLATION_RESERVATION_ID_MISSING");
      }

      const reservation = await prisma.reservation.findFirst({
        where: {
          id: reservationId,
          ...(message.propertyId
            ? { propertyId: message.propertyId }
            : {}),
          ...(message.organizationId
            ? {
                property: {
                  organizationId: message.organizationId,
                },
              }
            : {}),
        },
        include: {
          property: {
            select: {
              organizationId: true,
              name: true,
              timezone: true,
            },
          },
        },
      });

      if (!reservation) {
        throw new Error("MANUAL_CANCELLATION_RESERVATION_NOT_FOUND");
      }

      if (
        reservation.source !== "MANUAL" ||
        reservation.externalProvider !== "PIN_GO_MANUAL" ||
        reservation.status !== "CANCELLED"
      ) {
        throw new Error("MANUAL_CANCELLATION_RESERVATION_SCOPE_INVALID");
      }

      const guestEmail = String(reservation.guestEmail ?? "").trim();

      if (!guestEmail || guestEmail !== message.to.trim()) {
        throw new Error("MANUAL_CANCELLATION_EMAIL_DESTINATION_MISSING");
      }

      const guestReplyTo = await resolveOrganizationGuestReplyTo(
        prisma,
        reservation.property.organizationId
      );

      const sent = await sendManualReservationGuestCancellationEmail({
        to: guestEmail,
        replyTo: guestReplyTo.email,
        reservationNumber: reservation.reservationNumber ?? reservation.id,
        guestName: reservation.guestName,
        propertyName: reservation.property.name,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        propertyTimeZone: reservation.property.timezone,
        cancelledAt: reservation.cancelledAt ?? reservation.updatedAt,
        reason: reservation.cancellationReason ?? "Cancelled by host",
        preferredLanguage: reservation.preferredLanguage,
      });

      const providerMessageId =
        (sent as any)?.data?.id ??
        (sent as any)?.providerMessageId ??
        (sent as any)?.id ??
        null;

      await prisma.messageLog.update({
        where: {
          id: message.id,
        },
        data: {
          status: "SENT",
          providerMessageId,
          retryCount: {
            increment: 1,
          },
          error: null,
        },
      });

      try {
        await prisma.messageDispatchLog.create({
          data: {
            reservationId: reservation.id,
            type: "MANUAL_RESERVATION_GUEST_CANCELLATION",
            channel: "email",
            status: "SENT",
          },
        });
      } catch (dispatchLogError) {
        errLog("Manual cancellation email retry dispatch log failed", {
          messageId: message.id,
          reservationNumber: reservation.reservationNumber ?? null,
          error: toErrString(dispatchLogError),
        });
      }

      log("Manual cancellation email retry success", {
        messageId: message.id,
        reservationNumber: reservation.reservationNumber ?? null,
        retryCount: message.retryCount + 1,
      });
    } catch (error) {
      const errorMessage = toErrString(error);
      const nextRetryCount = message.retryCount + 1;
      const finalFailure =
        isNonRetryableManualCancellationEmailError(errorMessage) ||
        nextRetryCount >= MAX_RETRIES;

      try {
        await prisma.messageLog.update({
          where: {
            id: message.id,
          },
          data: {
            status: finalFailure ? "FAILED_FINAL" : "FAILED",
            retryCount: {
              increment: 1,
            },
            error: errorMessage,
          },
        });
      } catch (updateError) {
        errLog("Manual cancellation email retry update failed", {
          messageId: message.id,
          error: toErrString(updateError),
        });
      }

      errLog(
        finalFailure
          ? "Manual cancellation email retry stopped"
          : "Manual cancellation email retry failed",
        {
          messageId: message.id,
          retryCount: nextRetryCount,
          error: errorMessage,
        }
      );
    }
  }
}


function parsePropertyProtectionDamageNoticeRetryPayload(
  body: string
): { damageCaseId: string } | null {
  try {
    const parsed = JSON.parse(body);
    if (
      parsed?.kind !== "PIN_GO_EMAIL_DELIVERY" ||
      parsed?.type !== "PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE"
    ) {
      return null;
    }
    const damageCaseId = String(
      parsed?.retryPayload?.damageCaseId ?? ""
    ).trim();
    return damageCaseId ? { damageCaseId } : null;
  } catch {
    return null;
  }
}

async function processPropertyProtectionDamageNoticeRetries() {
  const failedEmailMessages = await prisma.messageLog.findMany({
    where: {
      channel: "email",
      provider: "resend",
      status: "FAILED",
      retryCount: { lt: MAX_RETRIES },
      communicationType: "PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE",
    },
    take: BATCH_SIZE,
    orderBy: { createdAt: "asc" },
  });

  for (const message of failedEmailMessages) {
    try {
      const payload = parsePropertyProtectionDamageNoticeRetryPayload(
        message.body
      );
      if (!payload) {
        throw new Error(
          "PROPERTY_PROTECTION_DAMAGE_NOTICE_RETRY_PAYLOAD_MISSING"
        );
      }

      const damageCase = await prisma.damageCase.findUnique({
        where: { id: payload.damageCaseId },
        include: {
          reservation: {
            select: {
              id: true,
              reservationNumber: true,
              guestName: true,
              guestEmail: true,
              guestToken: true,
              guestTokenExpiresAt: true,
              preferredLanguage: true,
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

      if (
        !damageCase ||
        damageCase.status !== "GUEST_NOTIFICATION_PENDING"
      ) {
        throw new Error(
          "PROPERTY_PROTECTION_DAMAGE_NOTICE_CASE_NOT_PENDING"
        );
      }

      const reservation = damageCase.reservation;
      const guestEmail = String(reservation.guestEmail ?? "").trim();
      const guestToken = String(reservation.guestToken ?? "").trim();

      if (!guestEmail || !guestToken || guestEmail !== message.to.trim()) {
        throw new Error(
          "PROPERTY_PROTECTION_DAMAGE_NOTICE_DESTINATION_MISSING"
        );
      }

      const appUrl = String(
        process.env.APP_URL ?? "http://localhost:3000"
      )
        .trim()
        .replace(/\/+$/, "");
      const manageReservationUrl =
        `${appUrl}/booking/manage/${encodeURIComponent(guestToken)}`;
      const minimumPortalExpiry = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      );
      if (
        reservation.guestTokenExpiresAt &&
        reservation.guestTokenExpiresAt.getTime() <
          minimumPortalExpiry.getTime()
      ) {
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: { guestTokenExpiresAt: minimumPortalExpiry },
        });
      }

      const replyTo = await resolveOrganizationGuestReplyTo(
        prisma,
        reservation.property.organizationId
      );

      const sent = await sendPropertyProtectionGuestDamageNotice({
        to: guestEmail,
        replyTo: replyTo.email,
        reservationNumber:
          reservation.reservationNumber ?? reservation.id,
        guestName: reservation.guestName,
        propertyName: reservation.property.name,
        manageReservationUrl,
        preferredLanguage: reservation.preferredLanguage,
        idempotencyKey:
          `property-protection-damage-notice-${damageCase.id}`,
      });

      const providerMessageId =
        (sent as any)?.data?.id ??
        (sent as any)?.id ??
        null;

      await prisma.$transaction([
        prisma.messageLog.update({
          where: { id: message.id },
          data: {
            status: "SENT",
            providerMessageId,
            retryCount: { increment: 1 },
            error: null,
          },
        }),
        prisma.damageCase.update({
          where: { id: damageCase.id },
          data: {
            status: "GUEST_NOTIFIED",
            guestNotifiedAt: new Date(),
          },
        }),
      ]);

      try {
        await prisma.messageDispatchLog.create({
          data: {
            reservationId: reservation.id,
            type: "PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE",
            channel: "email",
            status: "SENT",
          },
        });
      } catch (dispatchLogError) {
        errLog("Property Protection notice retry dispatch log failed", {
          messageId: message.id,
          error: toErrString(dispatchLogError),
        });
      }

      log("Property Protection damage notice retry success", {
        messageId: message.id,
        damageCaseId: damageCase.id,
        retryCount: message.retryCount + 1,
      });
    } catch (error) {
      const errorMessage = toErrString(error);
      const nextRetryCount = message.retryCount + 1;
      const nonRetryable =
        errorMessage.includes("RETRY_PAYLOAD_MISSING") ||
        errorMessage.includes("CASE_NOT_PENDING") ||
        errorMessage.includes("DESTINATION_MISSING");
      const finalFailure =
        nonRetryable || nextRetryCount >= MAX_RETRIES;

      await prisma.messageLog
        .update({
          where: { id: message.id },
          data: {
            status: finalFailure ? "FAILED_FINAL" : "FAILED",
            retryCount: { increment: 1 },
            error: errorMessage,
          },
        })
        .catch(() => {});

      errLog(
        finalFailure
          ? "Property Protection damage notice retry stopped"
          : "Property Protection damage notice retry failed",
        {
          messageId: message.id,
          retryCount: nextRetryCount,
          error: errorMessage,
        }
      );
    }
  }
}

function parsePropertyProtectionGuestClosureRetryPayload(
  body: string
): { damageCaseId: string } | null {
  try {
    const parsed = JSON.parse(body);
    if (
      parsed?.kind !== "PIN_GO_EMAIL_DELIVERY" ||
      parsed?.type !==
        "PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE"
    ) {
      return null;
    }
    const damageCaseId = String(
      parsed?.retryPayload?.damageCaseId ?? ""
    ).trim();
    return damageCaseId ? { damageCaseId } : null;
  } catch {
    return null;
  }
}

async function processPropertyProtectionGuestClosureRetries() {
  const failedEmailMessages = await prisma.messageLog.findMany({
    where: {
      channel: "email",
      provider: "resend",
      status: "FAILED",
      retryCount: { lt: MAX_RETRIES },
      communicationType:
        "PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE",
    },
    take: BATCH_SIZE,
    orderBy: { createdAt: "asc" },
  });

  for (const message of failedEmailMessages) {
    try {
      const payload = parsePropertyProtectionGuestClosureRetryPayload(
        message.body
      );
      if (!payload) {
        throw new Error(
          "PROPERTY_PROTECTION_GUEST_CLOSURE_RETRY_PAYLOAD_MISSING"
        );
      }

      const damageCase = await prisma.damageCase.findUnique({
        where: { id: payload.damageCaseId },
        select: {
          id: true,
          status: true,
          guestNotifiedAt: true,
          reservation: {
            select: {
              id: true,
              reservationNumber: true,
              guestName: true,
              guestEmail: true,
              guestToken: true,
              guestTokenExpiresAt: true,
              preferredLanguage: true,
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

      if (
        !damageCase ||
        damageCase.status !== "CLOSED_NO_CHARGE" ||
        !damageCase.guestNotifiedAt
      ) {
        throw new Error(
          "PROPERTY_PROTECTION_GUEST_CLOSURE_CASE_NOT_ELIGIBLE"
        );
      }

      const reservation = damageCase.reservation;
      const guestEmail = String(reservation.guestEmail ?? "").trim();
      const guestToken = String(reservation.guestToken ?? "").trim();

      if (!guestEmail || !guestToken || guestEmail !== message.to.trim()) {
        throw new Error(
          "PROPERTY_PROTECTION_GUEST_CLOSURE_DESTINATION_MISSING"
        );
      }

      const appUrl = String(
        process.env.APP_URL ?? "http://localhost:3000"
      )
        .trim()
        .replace(/\/+$/, "");
      const manageReservationUrl =
        `${appUrl}/booking/manage/${encodeURIComponent(guestToken)}`;
      const minimumPortalExpiry = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      );
      if (
        reservation.guestTokenExpiresAt &&
        reservation.guestTokenExpiresAt.getTime() <
          minimumPortalExpiry.getTime()
      ) {
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: { guestTokenExpiresAt: minimumPortalExpiry },
        });
      }

      const replyTo = await resolveOrganizationGuestReplyTo(
        prisma,
        reservation.property.organizationId
      );
      const sent = await sendPropertyProtectionGuestClosureNotice({
        to: guestEmail,
        replyTo: replyTo.email,
        reservationNumber:
          reservation.reservationNumber ?? reservation.id,
        guestName: reservation.guestName,
        propertyName: reservation.property.name,
        manageReservationUrl,
        preferredLanguage: reservation.preferredLanguage,
        idempotencyKey:
          `property-protection-no-charge-closure-${damageCase.id}`,
      });
      const providerMessageId =
        (sent as any)?.data?.id ?? (sent as any)?.id ?? null;

      await prisma.messageLog.update({
        where: { id: message.id },
        data: {
          status: "SENT",
          providerMessageId,
          retryCount: { increment: 1 },
          error: null,
        },
      });

      try {
        await prisma.messageDispatchLog.create({
          data: {
            reservationId: reservation.id,
            type: "PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE",
            channel: "email",
            status: "SENT",
          },
        });
      } catch (dispatchLogError) {
        errLog("Property Protection closure retry dispatch log failed", {
          messageId: message.id,
          error: toErrString(dispatchLogError),
        });
      }

      log("Property Protection guest closure retry success", {
        messageId: message.id,
        damageCaseId: damageCase.id,
        retryCount: message.retryCount + 1,
      });
    } catch (error) {
      const errorMessage = toErrString(error);
      const nextRetryCount = message.retryCount + 1;
      const nonRetryable =
        errorMessage.includes("RETRY_PAYLOAD_MISSING") ||
        errorMessage.includes("CASE_NOT_ELIGIBLE") ||
        errorMessage.includes("DESTINATION_MISSING");
      const finalFailure =
        nonRetryable || nextRetryCount >= MAX_RETRIES;

      await prisma.messageLog
        .update({
          where: { id: message.id },
          data: {
            status: finalFailure ? "FAILED_FINAL" : "FAILED",
            retryCount: { increment: 1 },
            error: errorMessage,
          },
        })
        .catch(() => {});

      errLog(
        finalFailure
          ? "Property Protection guest closure retry stopped"
          : "Property Protection guest closure retry failed",
        {
          messageId: message.id,
          retryCount: nextRetryCount,
          error: errorMessage,
        }
      );
    }
  }
}

function parsePropertyProtectionHostResponseRetryPayload(
  body: string
): {
  damageCaseId: string;
  guestResponse: "ACCEPTED" | "DISPUTED";
  recipientEmail: string;
  hostName: string | null;
} | null {
  try {
    const parsed = JSON.parse(body);
    if (
      parsed?.kind !== "PIN_GO_EMAIL_DELIVERY" ||
      parsed?.type !== "PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE"
    ) {
      return null;
    }

    const damageCaseId = String(
      parsed?.retryPayload?.damageCaseId ?? ""
    ).trim();
    const guestResponse = String(
      parsed?.retryPayload?.guestResponse ?? ""
    ).trim();
    const recipientEmail = String(
      parsed?.retryPayload?.recipientEmail ?? ""
    )
      .trim()
      .toLowerCase();
    const hostNameValue = String(
      parsed?.retryPayload?.hostName ?? ""
    ).trim();

    if (
      !damageCaseId ||
      !recipientEmail ||
      (guestResponse !== "ACCEPTED" && guestResponse !== "DISPUTED")
    ) {
      return null;
    }

    return {
      damageCaseId,
      guestResponse,
      recipientEmail,
      hostName: hostNameValue || null,
    };
  } catch {
    return null;
  }
}

async function processPropertyProtectionHostResponseRetries() {
  const failedEmailMessages = await prisma.messageLog.findMany({
    where: {
      channel: "email",
      provider: "resend",
      status: "FAILED",
      retryCount: { lt: MAX_RETRIES },
      communicationType:
        "PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE",
    },
    take: BATCH_SIZE,
    orderBy: { createdAt: "asc" },
  });

  for (const message of failedEmailMessages) {
    try {
      const payload =
        parsePropertyProtectionHostResponseRetryPayload(message.body);
      if (!payload) {
        throw new Error(
          "PROPERTY_PROTECTION_HOST_RESPONSE_RETRY_PAYLOAD_MISSING"
        );
      }

      const damageCase = await prisma.damageCase.findUnique({
        where: { id: payload.damageCaseId },
        select: {
          id: true,
          guestResponse: true,
          reservation: {
            select: {
              id: true,
              reservationNumber: true,
              property: { select: { name: true } },
            },
          },
        },
      });

      if (
        !damageCase ||
        damageCase.guestResponse !== payload.guestResponse
      ) {
        throw new Error(
          "PROPERTY_PROTECTION_HOST_RESPONSE_CASE_CHANGED"
        );
      }

      if (
        payload.recipientEmail !==
        String(message.to ?? "").trim().toLowerCase()
      ) {
        throw new Error(
          "PROPERTY_PROTECTION_HOST_RESPONSE_DESTINATION_MISMATCH"
        );
      }

      const appUrl = String(
        process.env.APP_URL ?? "http://localhost:3000"
      )
        .trim()
        .replace(/\/+$/, "");
      const reservationDetailUrl =
        `${appUrl}/reservations/${encodeURIComponent(
          damageCase.reservation.id
        )}`;

      const sent =
        await sendPropertyProtectionHostGuestResponseNotice({
          to: payload.recipientEmail,
          hostName: payload.hostName,
          reservationNumber:
            damageCase.reservation.reservationNumber ??
            damageCase.reservation.id,
          propertyName: damageCase.reservation.property.name,
          guestResponse: payload.guestResponse,
          reservationDetailUrl,
          idempotencyKey:
            `property-protection-host-response-${damageCase.id}-${payload.guestResponse}-${payload.recipientEmail}`,
        });

      const providerMessageId =
        (sent as any)?.data?.id ?? (sent as any)?.id ?? null;

      await prisma.messageLog.update({
        where: { id: message.id },
        data: {
          status: "SENT",
          providerMessageId,
          retryCount: { increment: 1 },
          error: null,
        },
      });

      try {
        await prisma.messageDispatchLog.create({
          data: {
            reservationId: damageCase.reservation.id,
            type: "PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE",
            channel: "email",
            status: "SENT",
          },
        });
      } catch (dispatchLogError) {
        errLog("Property Protection host response retry dispatch log failed", {
          messageId: message.id,
          error: toErrString(dispatchLogError),
        });
      }

      log("Property Protection host response retry success", {
        messageId: message.id,
        damageCaseId: damageCase.id,
        retryCount: message.retryCount + 1,
      });
    } catch (error) {
      const errorMessage = toErrString(error);
      const nextRetryCount = message.retryCount + 1;
      const nonRetryable =
        errorMessage.includes("RETRY_PAYLOAD_MISSING") ||
        errorMessage.includes("CASE_CHANGED") ||
        errorMessage.includes("DESTINATION_MISMATCH");
      const finalFailure =
        nonRetryable || nextRetryCount >= MAX_RETRIES;

      await prisma.messageLog
        .update({
          where: { id: message.id },
          data: {
            status: finalFailure ? "FAILED_FINAL" : "FAILED",
            retryCount: { increment: 1 },
            error: errorMessage,
          },
        })
        .catch(() => {});

      errLog(
        finalFailure
          ? "Property Protection host response retry stopped"
          : "Property Protection host response retry failed",
        {
          messageId: message.id,
          retryCount: nextRetryCount,
          error: errorMessage,
        }
      );
    }
  }
}

let shuttingDown = false;
let tickRunning = false;

async function tick() {
  if (shuttingDown) return;

  if (tickRunning) {
    log(
      "Tick skipped because the previous retry cycle is still running"
    );
    return;
  }

  tickRunning = true;

  try {
    try {
      await processRetries();
    } catch (e) {
      errLog(
        "processRetries crashed",
        {
          err: toErrString(e),
        }
      );
    }

    try {
      await processGuestAccessEmailRetries();
    } catch (e) {
      errLog(
        "processGuestAccessEmailRetries crashed",
        {
          err: toErrString(e),
        }
      );
    }

    try {
      await processManualCancellationEmailRetries();
    } catch (e) {
      errLog(
        "processManualCancellationEmailRetries crashed",
        {
          err: toErrString(e),
        }
      );
    }

    try {
      await processPropertyProtectionDamageNoticeRetries();
    } catch (e) {
      errLog(
        "processPropertyProtectionDamageNoticeRetries crashed",
        {
          err: toErrString(e),
        }
      );
    }

    try {
      await processPropertyProtectionHostResponseRetries();
    } catch (e) {
      errLog(
        "processPropertyProtectionHostResponseRetries crashed",
        {
          err: toErrString(e),
        }
      );
    }

    try {
      await processPropertyProtectionGuestClosureRetries();
    } catch (e) {
      errLog(
        "processPropertyProtectionGuestClosureRetries crashed",
        {
          err: toErrString(e),
        }
      );
    }
  } finally {
    tickRunning = false;
  }
}

async function start() {
  log(
    `Starting retry worker. poll=${POLL_MS}ms batch=${BATCH_SIZE} maxRetries=${MAX_RETRIES}`
  );

  await tick();

  const interval = setInterval(() => void tick(), POLL_MS);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log(`Received ${signal}. Shutting down...`);
    clearInterval(interval);

    try {
      await prisma.$disconnect();
      log("Disconnected Prisma. Bye.");
    } catch (e) {
      errLog("Error on disconnect", { err: toErrString(e) });
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void start().catch((e) => {
  errLog("Fatal start error", { err: toErrString(e) });
  process.exit(1);
});
