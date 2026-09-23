import { DamageCaseStatus, PrismaClient } from "@prisma/client";
import { isDamageCaseAfterCheckout } from "./damage-case-checkout.policy.js";
import { sendPropertyProtectionGuestClosureNotice } from "../lib/mailer.js";
import { sendLoggedEmail } from "./email-delivery.service.js";
import { resolveOrganizationGuestReplyTo } from "./organization-guest-email.service.js";

const COMMUNICATION_TYPE =
  "PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE" as const;

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

export async function notifyGuestOfNoChargeDamageCaseClosure(input: {
  prisma: PrismaClient;
  damageCaseId: string;
}) {
  const damageCase = await input.prisma.damageCase.findUnique({
    where: { id: input.damageCaseId },
    select: {
      id: true,
      status: true,
      guestNotifiedAt: true,
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

  if (damageCase.status !== DamageCaseStatus.CLOSED_NO_CHARGE) {
    return {
      ok: false,
      code: "DAMAGE_CASE_GUEST_CLOSURE_NOTICE_NOT_READY" as const,
    };
  }

  if (!damageCase.guestNotifiedAt) {
    return {
      ok: true,
      skipped: true,
      code: "DAMAGE_CASE_GUEST_CLOSURE_NOTICE_NOT_PREVIOUSLY_VISIBLE" as const,
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
    return {
      ok: false,
      code: "DAMAGE_CASE_GUEST_CLOSURE_NOTICE_DESTINATION_MISSING" as const,
    };
  }

  const existing = await input.prisma.messageLog.findFirst({
    where: {
      reservationId: reservation.id,
      communicationType: COMMUNICATION_TYPE,
      channel: "email",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });

  if (existing?.status === "SENT") {
    return { ok: true, alreadySent: true, messageLogId: existing.id };
  }

  if (existing?.status === "FAILED") {
    return {
      ok: false,
      pendingRetry: true,
      messageLogId: existing.id,
      code: "DAMAGE_CASE_GUEST_CLOSURE_NOTICE_RETRY_PENDING" as const,
    };
  }

  const minimumPortalExpiry = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  );

  if (
    reservation.guestTokenExpiresAt &&
    reservation.guestTokenExpiresAt.getTime() < minimumPortalExpiry.getTime()
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
      ? `Caso de Protección de la propiedad cerrado — Reservación #${reservation.reservationNumber}`
      : `Property Protection case closed — Reservation #${reservation.reservationNumber}`;

  const delivery = await sendLoggedEmail({
    prisma: input.prisma,
    type: COMMUNICATION_TYPE,
    to: reservation.guestEmail,
    subject,
    reservationId: reservation.id,
    propertyId: reservation.propertyId,
    organizationId: reservation.property.organizationId,
    retryPayload: { damageCaseId: damageCase.id },
    send: () =>
      sendPropertyProtectionGuestClosureNotice({
        to: reservation.guestEmail!,
        replyTo: replyTo.email,
        reservationNumber:
          reservation.reservationNumber ?? reservation.id,
        guestName: reservation.guestName,
        propertyName: reservation.property.name,
        manageReservationUrl,
        preferredLanguage: reservation.preferredLanguage,
        idempotencyKey:
          `property-protection-no-charge-closure-${damageCase.id}`,
      }),
  });

  if (!delivery.ok || delivery.status !== "SENT") {
    return {
      ok: false,
      code: "DAMAGE_CASE_GUEST_CLOSURE_NOTICE_DELIVERY_FAILED" as const,
      delivery,
    };
  }

  return { ok: true, alreadySent: false, delivery };
}
