import dotenv from "dotenv";
dotenv.config({ path: "./.env", override: true });

import { prisma } from "../lib/prisma";
import { sendSms } from "../integrations/twilio/twilio.client";
import {
  decryptAccessCode,
} from "../services/access-code-crypto.service";
import {
  recordCommunicationDeliveryFailure,
  resolveCommunicationDeliveryIssue,
} from "../services/communications-operational.service";

import {
  sendGuestAccessPasscodeEmail,
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

type CommunicationLifecycleContext = {
  messageId: string;
  channel: "sms" | "email";
  messageType: string;
  reservationId: string | null;
  propertyId: string | null;
  organizationId: string | null;
};

async function recordCommunicationFailureSafe(
  input: CommunicationLifecycleContext & {
    retryCount: number;
    error: unknown;
    failureKind:
      | "RETRYABLE"
      | "NON_RETRYABLE"
      | "RETRY_BUDGET_EXHAUSTED";
    nextAttemptAt?: Date | null;
    occurredAt: Date;
  }
) {
  try {
    await recordCommunicationDeliveryFailure({
      prisma,
      messageId: input.messageId,
      channel: input.channel,
      messageType: input.messageType,
      reservationId: input.reservationId,
      propertyId: input.propertyId,
      organizationId: input.organizationId,
      retryCount: input.retryCount,
      maxRetries: MAX_RETRIES,
      error: input.error,
      failureKind: input.failureKind,
      nextAttemptAt:
        input.nextAttemptAt ?? null,
      occurredAt: input.occurredAt,
    });
  } catch (operationalError) {
    errLog(
      "Communications operational failure could not be persisted",
      {
        messageId: input.messageId,
        channel: input.channel,
        messageType: input.messageType,
        retryCount: input.retryCount,
        failureKind: input.failureKind,
        error:
          toErrString(operationalError),
      }
    );
  }
}

async function resolveCommunicationIssueSafe(
  input: CommunicationLifecycleContext & {
    retryCount: number;
    occurredAt: Date;
  }
) {
  try {
    await resolveCommunicationDeliveryIssue({
      prisma,
      messageId: input.messageId,
      channel: input.channel,
      messageType: input.messageType,
      reservationId: input.reservationId,
      propertyId: input.propertyId,
      organizationId: input.organizationId,
      retryCount: input.retryCount,
      occurredAt: input.occurredAt,
    });
  } catch (operationalError) {
    errLog(
      "Communications operational resolution could not be persisted",
      {
        messageId: input.messageId,
        channel: input.channel,
        messageType: input.messageType,
        retryCount: input.retryCount,
        error:
          toErrString(operationalError),
      }
    );
  }
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
  const exhaustedSmsMessages =
    await prisma.messageLog.findMany({
      where: {
        channel: "sms",
        status: "FAILED",
        retryCount: {
          gte: MAX_RETRIES,
        },
      },
      take: BATCH_SIZE,
      orderBy: {
        createdAt: "asc",
      },
    });

  let finalizedExhaustedCount = 0;

  for (const message of exhaustedSmsMessages) {
    const occurredAt = new Date();

    const finalized =
      await prisma.messageLog.updateMany({
        where: {
          id: message.id,
          status: "FAILED",
          retryCount: {
            gte: MAX_RETRIES,
          },
        },
        data: {
          status: "FAILED_FINAL",
        },
      });

    if (finalized.count !== 1) {
      continue;
    }

    finalizedExhaustedCount += 1;

    await recordCommunicationFailureSafe({
      messageId: message.id,
      channel: "sms",
      messageType: "SMS",
      reservationId:
        message.reservationId ?? null,
      propertyId:
        message.propertyId ?? null,
      organizationId:
        message.organizationId ?? null,
      retryCount: message.retryCount,
      error:
        message.error ??
        "SMS retry budget exhausted",
      failureKind:
        "RETRY_BUDGET_EXHAUSTED",
      occurredAt,
    });
  }

  if (finalizedExhaustedCount > 0) {
    errLog("SMS retry budget reconciled", {
      finalizedCount:
        finalizedExhaustedCount,
      maxRetries: MAX_RETRIES,
    });
  }

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
        const occurredAt = new Date();
        const nonRetryableError =
          msg.error ??
          "Non-retryable SMS delivery error";

        await prisma.messageLog.update({
          where: { id: msg.id },
          data: {
            status: "FAILED_FINAL",
            error: nonRetryableError,
          },
        });

        await recordCommunicationFailureSafe({
          messageId: msg.id,
          channel: "sms",
          messageType: "SMS",
          reservationId:
            msg.reservationId ?? null,
          propertyId:
            msg.propertyId ?? null,
          organizationId:
            msg.organizationId ?? null,
          retryCount: msg.retryCount,
          error: nonRetryableError,
          failureKind: "NON_RETRYABLE",
          occurredAt,
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
      const resolvedAt = new Date();

      await prisma.messageLog.update({
        where: { id: msg.id },
        data: {
          status: "SENT",
          providerMessageId: (sent as any)?.sid ?? null,
          retryCount: { increment: 1 },
          error: null,
        },
      });

      await resolveCommunicationIssueSafe({
        messageId: msg.id,
        channel: "sms",
        messageType: "SMS",
        reservationId:
          msg.reservationId ?? null,
        propertyId:
          msg.propertyId ?? null,
        organizationId:
          msg.organizationId ?? null,
        retryCount: msg.retryCount + 1,
        occurredAt: resolvedAt,
      });

      log("SMS retry success", {
        id: msg.id,
        sid: (sent as any)?.sid ?? null,
      });
    } catch (e) {
      const err = toErrString(e);
      const nonRetryable = isNonRetryableSmsError(err);
      const nextRetryCount = msg.retryCount + 1;
      const finalFailure =
        nonRetryable ||
        nextRetryCount >= MAX_RETRIES;
      const occurredAt = new Date();
      let stateApplied = false;

      try {
        await prisma.messageLog.update({
          where: { id: msg.id },
          data: {
            status: finalFailure
              ? "FAILED_FINAL"
              : "FAILED",
            retryCount: { increment: 1 },
            error: err,
          },
        });
        stateApplied = true;
      } catch (updateErr) {
        errLog("SMS retry update failed", {
          id: msg.id,
          err: toErrString(updateErr),
        });
      }

      if (stateApplied) {
        await recordCommunicationFailureSafe({
          messageId: msg.id,
          channel: "sms",
          messageType: "SMS",
          reservationId:
            msg.reservationId ?? null,
          propertyId:
            msg.propertyId ?? null,
          organizationId:
            msg.organizationId ?? null,
          retryCount: nextRetryCount,
          error: err,
          failureKind: nonRetryable
            ? "NON_RETRYABLE"
            : finalFailure
            ? "RETRY_BUDGET_EXHAUSTED"
            : "RETRYABLE",
          nextAttemptAt: finalFailure
            ? null
            : new Date(
                occurredAt.getTime() + POLL_MS
              ),
          occurredAt,
        });
      }

      if (finalFailure) {
        errLog("SMS retry stopped", {
          id: msg.id,
          to: msg.to,
          retryCount: nextRetryCount,
          reason: nonRetryable
            ? "NON_RETRYABLE_ERROR"
            : "RETRY_BUDGET_EXHAUSTED",
          err,
        });
      } else {
        errLog("SMS retry failed", {
          id: msg.id,
          retryCount: nextRetryCount,
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
      const resolvedAt = new Date();

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

      await resolveCommunicationIssueSafe({
        messageId: message.id,
        channel: "email",
        messageType:
          "GUEST_ACCESS_PASSCODE",
        reservationId:
          grant.reservation.id,
        propertyId:
          grant.reservation.property.id,
        organizationId:
          grant.reservation.property
            .organizationId,
        retryCount:
          message.retryCount + 1,
        occurredAt: resolvedAt,
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
      const occurredAt = new Date();
      let stateApplied = false;

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
        stateApplied = true;
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

      if (stateApplied) {
        await recordCommunicationFailureSafe({
          messageId: message.id,
          channel: "email",
          messageType:
            "GUEST_ACCESS_PASSCODE",
          reservationId:
            message.reservationId ?? null,
          propertyId:
            message.propertyId ?? null,
          organizationId:
            message.organizationId ?? null,
          retryCount: nextRetryCount,
          error: errorMessage,
          failureKind: nonRetryable
            ? "NON_RETRYABLE"
            : finalFailure
            ? "RETRY_BUDGET_EXHAUSTED"
            : "RETRYABLE",
          nextAttemptAt: finalFailure
            ? null
            : new Date(
                occurredAt.getTime() + POLL_MS
              ),
          occurredAt,
        });
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
