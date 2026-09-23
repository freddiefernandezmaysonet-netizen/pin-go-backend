import {
  DamageCaseGuestResponse,
  DashboardUserRole,
  PrismaClient,
} from "@prisma/client";
import { sendPropertyProtectionHostGuestResponseNotice } from "../lib/mailer.js";
import { sendLoggedEmail } from "./email-delivery.service.js";

const COMMUNICATION_TYPE =
  "PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE" as const;

type FinalGuestResponse =
  | typeof DamageCaseGuestResponse.ACCEPTED
  | typeof DamageCaseGuestResponse.DISPUTED;

function getAppUrl() {
  return String(process.env.APP_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
}

function buildReservationDetailUrl(reservationId: string) {
  const id = String(reservationId ?? "").trim();
  return id ? `${getAppUrl()}/reservations/${encodeURIComponent(id)}` : null;
}

async function getHostRecipients(
  prisma: PrismaClient,
  organizationId: string
) {
  const admins = await prisma.dashboardUser.findMany({
    where: {
      organizationId,
      isActive: true,
      role: DashboardUserRole.ORG_ADMIN,
    },
    select: { email: true, fullName: true },
    orderBy: { createdAt: "asc" },
  });

  const seen = new Set<string>();
  return admins.flatMap((user) => {
    const email = String(user.email ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) return [];
    seen.add(email);
    return [{ email, fullName: user.fullName }];
  });
}

export async function notifyHostOfGuestDamageCaseResponse(input: {
  prisma: PrismaClient;
  damageCaseId: string;
  expectedResponse?: FinalGuestResponse;
}) {
  const damageCase = await input.prisma.damageCase.findUnique({
    where: { id: input.damageCaseId },
    select: {
      id: true,
      guestResponse: true,
      reservation: {
        select: {
          id: true,
          reservationNumber: true,
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

  if (!damageCase) {
    return { ok: false, code: "DAMAGE_CASE_NOT_FOUND" as const };
  }

  if (
    damageCase.guestResponse !== DamageCaseGuestResponse.ACCEPTED &&
    damageCase.guestResponse !== DamageCaseGuestResponse.DISPUTED
  ) {
    return {
      ok: false,
      code: "DAMAGE_CASE_HOST_NOTIFICATION_NOT_FINAL" as const,
    };
  }

  if (
    input.expectedResponse &&
    damageCase.guestResponse !== input.expectedResponse
  ) {
    return {
      ok: false,
      code: "DAMAGE_CASE_HOST_NOTIFICATION_RESPONSE_CHANGED" as const,
    };
  }

  const guestResponse = damageCase.guestResponse as FinalGuestResponse;
  const reservation = damageCase.reservation;
  const reservationDetailUrl = buildReservationDetailUrl(reservation.id);
  if (!reservationDetailUrl) {
    return {
      ok: false,
      code: "DAMAGE_CASE_HOST_NOTIFICATION_URL_MISSING" as const,
    };
  }

  const recipients = await getHostRecipients(
    input.prisma,
    reservation.property.organizationId
  );

  if (recipients.length === 0) {
    return {
      ok: false,
      code: "DAMAGE_CASE_HOST_NOTIFICATION_DESTINATION_MISSING" as const,
    };
  }

  let sent = 0;
  let alreadySent = 0;
  let pendingRetry = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const existing = await input.prisma.messageLog.findFirst({
      where: {
        reservationId: reservation.id,
        communicationType: COMMUNICATION_TYPE,
        channel: "email",
        to: recipient.email,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });

    if (existing?.status === "SENT") {
      alreadySent += 1;
      continue;
    }

    if (existing?.status === "FAILED") {
      pendingRetry += 1;
      continue;
    }

    const subject =
      `Property Protection response / Respuesta — Reservation #${reservation.reservationNumber}`;
    const delivery = await sendLoggedEmail({
      prisma: input.prisma,
      type: COMMUNICATION_TYPE,
      to: recipient.email,
      subject,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId: reservation.property.organizationId,
      retryPayload: {
        damageCaseId: damageCase.id,
        guestResponse: guestResponse,
        recipientEmail: recipient.email,
        hostName: recipient.fullName,
      },
      send: () =>
        sendPropertyProtectionHostGuestResponseNotice({
          to: recipient.email,
          hostName: recipient.fullName,
          reservationNumber:
            reservation.reservationNumber ?? reservation.id,
          propertyName: reservation.property.name,
          guestResponse: guestResponse,
          reservationDetailUrl,
          idempotencyKey:
            `property-protection-host-response-${damageCase.id}-${guestResponse}-${recipient.email}`,
        }),
    });

    if (delivery.ok && delivery.status === "SENT") {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  return {
    ok: failed === 0,
    sent,
    alreadySent,
    pendingRetry,
    failed,
    guestResponse: guestResponse,
  };
}
