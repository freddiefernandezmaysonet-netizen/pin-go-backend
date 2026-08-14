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
} from "../lib/mailer";
import { resolveOrganizationGuestReplyTo } from "../services/organization-guest-email.service";

const WORKER_NAME = "message.retry.worker";
const POLL_MS = Number(process.env.MESSAGE_RETRY_POLL_MS ?? 30000);
const MAX_RETRIES = Number(process.env.MESSAGE_MAX_RETRIES ?? 3);
const BATCH_SIZE = Number(process.env.MESSAGE_RETRY_BATCH_SIZE ?? 20);

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
