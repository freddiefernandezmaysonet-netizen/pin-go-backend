import { withdrawCleaning } from "./cleaning-reassignment.service.js";
import { issueCleanerActivation } from "./cleaner-account.service.js";
import { prepareChecklistSnapshot } from "./cleaning-checklist.service.js";
import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";
import { buildCleaningConfirmationSmsBody } from "./cleaning-confirmation-sms-body.service";
import { getStaffIntlLocale, resolveStaffLanguage } from "./staff-language.service.js";
import { isInternalDemo } from "./internal-demo-scope.js";
import { sendInternalDemoMessage } from "./internal-demo-message.service.js";
import { isWithinCleaningMessageHours, recordDeferredCleaningOfferAttention, resolveDeferredCleaningOfferAttention } from "./cleaning-offer-hours.service.js";

const DISPATCH_TYPE = "CLEANING_CONFIRMATION";
const FAILED_RETRY_COOLDOWN_MINUTES = 15;
const FALLBACK_AFTER_MINUTES = 120;

async function isCleaningNfcEnabledForProperty(
  prisma: PrismaClient,
  propertyId: string
) {
  const property = await prisma.property.findUnique({
    where: {
      id: propertyId,
    },
    select: {
      cleaningNfcEnabled: true,
    },
  });

  return property?.cleaningNfcEnabled === true;
}

function buildConfirmUrl(token: string) {
  const rawBaseUrl =
    process.env.API_BASE_URL ??
    process.env.PUBLIC_API_BASE_URL ??
    process.env.APP_URL;

  if (!rawBaseUrl) return null;

  const baseUrl = rawBaseUrl.replace(/\/$/, "");
  return `${baseUrl}/cleaning/confirm/${token}`;
}

async function sendCleaningConfirmationSms(params: {
  prisma: PrismaClient;
  send?: typeof sendSms;
  confirmation: {
    id: string;
    reservationId: string;
    propertyId: string;
    staffMemberId: string;
    token: string;
  };
  now: Date;
}) {
  const { prisma, confirmation, now } = params;

  const cleaningNfcEnabled =
  await isCleaningNfcEnabledForProperty(
    prisma,
    confirmation.propertyId
  );

if (!cleaningNfcEnabled) {
  console.log(
    "[CLEANING_CONFIRMATION_DISPATCH] skipped because cleaning NFC is disabled",
    {
      confirmationId: confirmation.id,
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      staffMemberId: confirmation.staffMemberId,
      reason: "CLEANING_NFC_DISABLED",
    }
  );

  return {
    ok: true,
    skipped: true,
    reason: "cleaning_nfc_disabled",
  };
}

  const [reservation, staff] = await Promise.all([
    prisma.reservation.findUnique({
      where: { id: confirmation.reservationId },
      include: { property: true },
    }),
    prisma.staffMember.findUnique({
      where: { id: confirmation.staffMemberId },
    }),
  ]);

  if (!reservation || !staff?.phoneE164) {
    return { ok: false, skipped: true, reason: "missing_reservation_or_staff_phone" };
  }

  const timezone = reservation.property?.timezone ?? "America/Puerto_Rico";
  const language = resolveStaffLanguage(staff.preferredLanguage);

  const raw = reservation.externalRaw as Record<string, any> | null;
  const demoAuthorized = isInternalDemo(reservation) && raw?.demoRun?.cleanerId === staff.id &&
    raw?.demoRun?.afterHoursAuthorized === true;
  if (isInternalDemo(reservation) && !demoAuthorized) {
    return { ok: false, skipped: true, reason: "demo_recipient_not_authorized" };
  }
  if (!demoAuthorized && !isWithinCleaningMessageHours(timezone, now)) {
    await recordDeferredCleaningOfferAttention(prisma, confirmation.id, now);
    return { ok: false, skipped: true, reason: "outside_allowed_hours" };
  }

  const recentFailed = await prisma.messageDispatchLog.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      type: DISPATCH_TYPE,
      channel: "sms",
      status: "FAILED",
      createdAt: {
        gte: new Date(now.getTime() - FAILED_RETRY_COOLDOWN_MINUTES * 60_000),
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (recentFailed) {
    return { ok: false, skipped: true, reason: "recent_failed_sms" };
  }

  const alreadySentForThisConfirmation = await prisma.messageLog.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      to: staff.phoneE164,
      channel: "sms",
      provider: "twilio",
      status: "SENT",
      body: {
        contains: confirmation.token,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (alreadySentForThisConfirmation) {
    await resolveDeferredCleaningOfferAttention(prisma, confirmation.id, now);
    return { ok: true, skipped: true, reason: "already_sent_for_confirmation" };
  }

  let confirmUrl = buildConfirmUrl(confirmation.token);

  if (!confirmUrl) {
    console.warn("[CLEANING_CONFIRMATION_DISPATCH] missing API base url", {
      confirmationId: confirmation.id,
      reservationId: confirmation.reservationId,
    });

    return { ok: false, skipped: true, reason: "missing_api_base_url" };
  }

  if (staff.cleanerAccountEmail && !staff.dashboardUserId) {
    const activation = await issueCleanerActivation(prisma, confirmation.id, now);
    if (activation) confirmUrl += `?activation=${activation}`;
  }

  await prepareChecklistSnapshot(prisma, confirmation.reservationId);

  const propertyName =
    reservation.property?.name ??
    reservation.roomName ??
    "la propiedad asignada";

  const roomName = reservation.roomName ?? "N/A";

  const checkOutText = new Intl.DateTimeFormat(getStaffIntlLocale(language), {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(reservation.checkOut));

  const body = buildCleaningConfirmationSmsBody({
    propertyName,
    roomName,
    checkOutText,
    confirmUrl,
    language,
  });

  if (demoAuthorized) {
    const delivery = await sendInternalDemoMessage({ prisma, reservationId: reservation.id,
      propertyId: reservation.propertyId, organizationId: reservation.property.organizationId,
      channel: "sms", type: DISPATCH_TYPE, to: staff.phoneE164, body, key: confirmation.id,
      send: () => (params.send ?? sendSms)(staff.phoneE164!, body) });
    return { ok: delivery.ok, skipped: false, reason: delivery.status };
  }

  const sms = await sendSms(staff.phoneE164, body);

  await prisma.messageLog.create({
    data: {
      channel: "sms",
      to: staff.phoneE164,
      from: process.env.TWILIO_FROM_NUMBER ?? null,
      body,
      provider: "twilio",
      providerMessageId: (sms as any)?.sid ?? null,
      status: "SENT",
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      organizationId: reservation.property?.organizationId ?? null,
    },
  });

  await prisma.messageDispatchLog.create({
    data: {
      reservationId: confirmation.reservationId,
      type: DISPATCH_TYPE,
      channel: "sms",
      status: "SENT",
    },
  });
  await resolveDeferredCleaningOfferAttention(prisma, confirmation.id, now);

  console.log("[CLEANING_CONFIRMATION_DISPATCH] sms sent", {
    confirmationId: confirmation.id,
    reservationId: confirmation.reservationId,
    staffMemberId: confirmation.staffMemberId,
    to: staff.phoneE164,
    timezone,
  });

  return { ok: true, skipped: false };
}

async function maybeFallbackCleaningConfirmation(params: {
  prisma: PrismaClient;
  confirmation: {
    id: string;
    reservationId: string;
    propertyId: string;
    staffMemberId: string;
    token: string;
    status: string;
    createdAt: Date;
  };
  now: Date;
}) {
  const { prisma, confirmation, now } = params;

  const cleaningNfcEnabled =
  await isCleaningNfcEnabledForProperty(
    prisma,
    confirmation.propertyId
  );

if (!cleaningNfcEnabled) {
  console.log(
    "[CLEANING_CONFIRMATION_FALLBACK] skipped because cleaning NFC is disabled",
    {
      confirmationId: confirmation.id,
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      staffMemberId: confirmation.staffMemberId,
      reason: "CLEANING_NFC_DISABLED",
    }
  );

  return {
    fallbackCreated: false,
    reason: "cleaning_nfc_disabled",
  };
}

  const confirmed = await prisma.cleaningConfirmation.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      status: "CONFIRMED",
    },
  });

  if (confirmed) {
    return { fallbackCreated: false, reason: "already_confirmed" };
  }

  const sentLog = await prisma.messageLog.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      channel: "sms",
      provider: "twilio",
      status: "SENT",
      body: {
        contains: confirmation.token,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!sentLog) {
    return { fallbackCreated: false, reason: "sms_not_sent_yet" };
  }

  const expiresAt = new Date(
    sentLog.createdAt.getTime() + FALLBACK_AFTER_MINUTES * 60_000
  );

  if (now < expiresAt) {
    return { fallbackCreated: false, reason: "not_expired_yet" };
  }

  const property = await prisma.property.findUniqueOrThrow({ where: { id: confirmation.propertyId }, select: { organizationId: true } });
  const result = await withdrawCleaning(prisma, { confirmationId: confirmation.id, staffMemberId: confirmation.staffMemberId, organizationId: property.organizationId }, "expire", now);
  const nextConfirmation = result.nextConfirmationId ? await prisma.cleaningConfirmation.findUnique({ where: { id: result.nextConfirmationId } }) : null;
  return nextConfirmation ? { fallbackCreated: true, nextConfirmation } : { fallbackCreated: false, reason: "no_backup_available" };

}

export async function dispatchPendingCleaningConfirmationForReservation(params: {
  prisma: PrismaClient;
  reservationId: string;
  now?: Date;
  send?: typeof sendSms;
}) {
  const now = params.now ?? new Date();

  const confirmation = await params.prisma.cleaningConfirmation.findFirst({
    where: {
      reservationId: params.reservationId,
      status: "PENDING",
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      reservationId: true,
      propertyId: true,
      staffMemberId: true,
      token: true,
    },
  });

  if (!confirmation) {
    return {
      ok: true,
      skipped: true,
      sent: false,
      reason: "pending_cleaning_confirmation_not_found",
      reservationId: params.reservationId,
      confirmationId: null,
    };
  }

  const result = await sendCleaningConfirmationSms({
    prisma: params.prisma,
    confirmation,
    now,
    ...(params.send ? { send: params.send } : {}),
  });

  return {
    ...result,
    sent: result.ok && !result.skipped,
    reservationId: confirmation.reservationId,
    propertyId: confirmation.propertyId,
    staffMemberId: confirmation.staffMemberId,
    confirmationId: confirmation.id,
  };
}

export async function processPendingCleaningConfirmations(
  prisma: PrismaClient,
  now: Date = new Date()
) {
  // Keyset pagination keeps skipped offers from blocking later pending offers.
  // A stable timestamp/id boundary also survives status changes during fallback.
  let boundary: { createdAt: Date; id: string } | undefined;
  let processedCount = 0;
  let sentCount = 0;
  let skippedCount = 0;
  let fallbackCreatedCount = 0;
  let expiredCount = 0;

  while (true) {
    const confirmations = await prisma.cleaningConfirmation.findMany({
      where: {
        status: "PENDING",
        ...(boundary ? { OR: [
          { createdAt: { gt: boundary.createdAt } },
          { createdAt: boundary.createdAt, id: { gt: boundary.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 25,
    });
    if (confirmations.length === 0) break;
    const last = confirmations[confirmations.length - 1];
    boundary = { createdAt: last.createdAt, id: last.id };
    processedCount += confirmations.length;

    for (const confirmation of confirmations) {
      try {
        const fallbackResult = await maybeFallbackCleaningConfirmation({
          prisma,
          confirmation,
          now,
        });

        if (fallbackResult.reason === "cleaning_nfc_disabled") {
          skippedCount++;
          continue;
        }

        if (fallbackResult.reason === "already_confirmed") {
          skippedCount++;
          continue;
        }

        if (fallbackResult.reason === "no_backup_available") {
          expiredCount++;
          skippedCount++;
          continue;
        }

        if (fallbackResult.fallbackCreated && fallbackResult.nextConfirmation) {
          fallbackCreatedCount++;
          expiredCount++;

          const sent = await sendCleaningConfirmationSms({
            prisma,
            confirmation: fallbackResult.nextConfirmation,
            now,
          });

          if (sent.ok && !sent.skipped) {
            sentCount++;
          } else {
            skippedCount++;
          }

          continue;
        }

        const sent = await sendCleaningConfirmationSms({
          prisma,
          confirmation,
          now,
        });

        if (sent.ok && !sent.skipped) {
          sentCount++;
        } else {
          skippedCount++;
        }
      } catch (e: any) {
        console.error("[CLEANING_CONFIRMATION_DISPATCH] failed", {
          confirmationId: confirmation.id,
          reservationId: confirmation.reservationId,
          error: e?.message ?? String(e),
        });

        await prisma.messageDispatchLog
          .create({
            data: {
              reservationId: confirmation.reservationId,
              type: DISPATCH_TYPE,
              channel: "sms",
              status: "FAILED",
            },
          })
          .catch(() => {});

        skippedCount++;
      }
    }

    if (confirmations.length < 25) break;
  }

  return {
    processed: processedCount,
    sent: sentCount,
    skipped: skippedCount,
    fallbackCreated: fallbackCreatedCount,
    expired: expiredCount,
  };
}
