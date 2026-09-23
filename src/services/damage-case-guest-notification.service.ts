import { DamageCaseStatus, PrismaClient } from "@prisma/client";
import { isDamageCaseAfterCheckout } from "./damage-case-checkout.policy.js";
import { sendPropertyProtectionGuestDamageNotice } from "../lib/mailer.js";
import { sendLoggedEmail } from "./email-delivery.service.js";
import { resolveOrganizationGuestReplyTo } from "./organization-guest-email.service.js";
import { syncDamageCaseMissionControlSafely } from "./damage-case-mission-control.service.js";

const COMMUNICATION_TYPE = "PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE" as const;

function getAppUrl() {
  return String(process.env.APP_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
}

function buildManageReservationUrl(guestToken: string) {
  const token = String(guestToken ?? "").trim();
  if (!token) return null;
  return `${getAppUrl()}/booking/manage/${encodeURIComponent(token)}`;
}

export async function notifyGuestOfApprovedDamageCase(input: {
  prisma: PrismaClient;
  damageCaseId: string;
}) {
  const damageCase = await input.prisma.damageCase.findUnique({
    where: { id: input.damageCaseId },
    include: {
      reservation: {
        select: {
          id: true,
          checkOut: true,
          reservationNumber: true,
          guestName: true,
          guestEmail: true,
          guestToken: true,
          guestTokenExpiresAt: true,
          preferredLanguage: true,
          propertyId: true,
          property: {
            select: {
              id: true,
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
    damageCase.status !== DamageCaseStatus.GUEST_NOTIFICATION_PENDING &&
    damageCase.status !== DamageCaseStatus.GUEST_NOTIFIED
  ) {
    return {
      ok: false,
      code: "DAMAGE_CASE_GUEST_NOTIFICATION_NOT_READY" as const,
    };
  }

  const reservation = damageCase.reservation;
  if (!isDamageCaseAfterCheckout(reservation.checkOut)) {
    return { ok: false, code: "DAMAGE_CASE_CHECKOUT_REQUIRED" as const };
  }
  const manageReservationUrl = buildManageReservationUrl(
    reservation.guestToken ?? ""
  );

  if (!reservation.guestEmail || !manageReservationUrl) {
    await syncDamageCaseMissionControlSafely({
      prisma: input.prisma,
      damageCaseId: damageCase.id,
    });
    return {
      ok: false,
      code: "DAMAGE_CASE_GUEST_NOTIFICATION_DESTINATION_MISSING" as const,
    };
  }

  const alreadySent = await input.prisma.messageLog.findFirst({
    where: {
      reservationId: reservation.id,
      communicationType: COMMUNICATION_TYPE,
      channel: "email",
      status: "SENT",
    },
    select: { id: true },
  });

  if (alreadySent) {
    if (damageCase.status === DamageCaseStatus.GUEST_NOTIFICATION_PENDING) {
      await input.prisma.damageCase.update({
        where: { id: damageCase.id },
        data: {
          status: DamageCaseStatus.GUEST_NOTIFIED,
          guestNotifiedAt: damageCase.guestNotifiedAt ?? new Date(),
        },
      });
    }

    await syncDamageCaseMissionControlSafely({
      prisma: input.prisma,
      damageCaseId: damageCase.id,
    });

    return { ok: true, alreadySent: true, messageLogId: alreadySent.id };
  }

  const minimumPortalExpiry = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  );

  if (
    reservation.guestTokenExpiresAt &&
    reservation.guestTokenExpiresAt.getTime() <
      minimumPortalExpiry.getTime()
  ) {
    await input.prisma.reservation.update({
      where: { id: reservation.id },
      data: { guestTokenExpiresAt: minimumPortalExpiry },
    });
  }

  const replyTo = await resolveOrganizationGuestReplyTo(
    input.prisma,
    reservation.property.organizationId
  );

  const subject =
    String(reservation.preferredLanguage ?? "").toLowerCase() === "es"
      ? `Actualización de Protección de la propiedad — Reservación #${reservation.reservationNumber}`
      : `Property Protection update — Reservation #${reservation.reservationNumber}`;

  const delivery = await sendLoggedEmail({
    prisma: input.prisma,
    type: COMMUNICATION_TYPE,
    to: reservation.guestEmail,
    subject,
    reservationId: reservation.id,
    propertyId: reservation.propertyId,
    organizationId: reservation.property.organizationId,
    retryPayload: {
      damageCaseId: damageCase.id,
    },
    send: () =>
      sendPropertyProtectionGuestDamageNotice({
        to: reservation.guestEmail!,
        replyTo: replyTo.email,
        reservationNumber:
          reservation.reservationNumber ?? reservation.id,
        guestName: reservation.guestName,
        propertyName: reservation.property.name,
        manageReservationUrl,
        preferredLanguage: reservation.preferredLanguage,
        idempotencyKey: `property-protection-damage-notice-${damageCase.id}`,
      }),
  });

  if (!delivery.ok || delivery.status !== "SENT") {
    await syncDamageCaseMissionControlSafely({
      prisma: input.prisma,
      damageCaseId: damageCase.id,
    });
    return {
      ok: false,
      code: "DAMAGE_CASE_GUEST_NOTIFICATION_DELIVERY_FAILED" as const,
      delivery,
    };
  }

  const updated = await input.prisma.damageCase.updateMany({
    where: {
      id: damageCase.id,
      status: DamageCaseStatus.GUEST_NOTIFICATION_PENDING,
    },
    data: {
      status: DamageCaseStatus.GUEST_NOTIFIED,
      guestNotifiedAt: new Date(),
    },
  });

  await syncDamageCaseMissionControlSafely({
    prisma: input.prisma,
    damageCaseId: damageCase.id,
  });

  return {
    ok: true,
    alreadySent: false,
    transitioned: updated.count === 1,
    delivery,
  };
}
