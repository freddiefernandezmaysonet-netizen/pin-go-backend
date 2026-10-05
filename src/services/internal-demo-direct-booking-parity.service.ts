import { DashboardUserRole, PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import {
  sendDirectBookingGuestConfirmation,
  sendDirectBookingHostNotification,
} from "../lib/mailer";
import { sendLoggedEmail } from "./email-delivery.service";
import {
  buildCancellationPolicySnapshot,
  buildGuestCancellationTermsText,
  renderCancellationPolicySnapshot,
} from "./cancellation-policy.service";
import { resolveOrganizationGuestReplyTo } from "./organization-guest-email.service";

function getAppUrl() {
  return String(process.env.APP_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
}

function getPublicApiUrl() {
  return String(
    process.env.PUBLIC_API_BASE_URL ??
      process.env.API_BASE_URL ??
      "http://localhost:3000"
  )
    .trim()
    .replace(/\/+$/, "");
}

function buildManageReservationUrl(token: string) {
  return `${getAppUrl()}/booking/manage/${encodeURIComponent(token)}`;
}

function buildGuestVerificationUrl(token: string) {
  return `${getPublicApiUrl()}/guest/verify/${encodeURIComponent(token)}`;
}

async function ensureGuestToken(prisma: PrismaClient, reservationId: string) {
  const current = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { guestToken: true },
  });

  if (current?.guestToken) return current.guestToken;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const guestToken = randomBytes(32).toString("hex");
    try {
      const updated = await prisma.reservation.update({
        where: { id: reservationId },
        data: { guestToken },
        select: { guestToken: true },
      });
      if (updated.guestToken) return updated.guestToken;
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
    }
  }

  throw new Error("INTERNAL_DEMO_GUEST_TOKEN_CREATE_FAILED");
}

function getPolicySummary(snapshot: any) {
  return (
    String(snapshot?.guestFacingSummary ?? "").trim() ||
    String(snapshot?.description ?? "").trim() ||
    null
  );
}

function getRefundRules(snapshot: any) {
  return Array.isArray(snapshot?.refundRules) ? snapshot.refundRules : [];
}

export async function applyInternalDemoDirectBookingParity(
  prisma: PrismaClient,
  input: {
    reservationId: string;
    preferredLanguage: "es" | "en";
  }
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    include: {
      property: {
        select: {
          id: true,
          name: true,
          timezone: true,
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error("INTERNAL_DEMO_RESERVATION_NOT_FOUND");
  }

  const policy = await buildCancellationPolicySnapshot(reservation.propertyId);
  const acceptedAt = new Date().toISOString();
  const termsText = buildGuestCancellationTermsText(
    policy,
    input.preferredLanguage
  );
  const cancellationTermsAcceptance = {
    accepted: true,
    acceptedAt,
    text: termsText,
    source: "INTERNAL_DEMO_CENTER",
    version: "cancellation_terms_ack_v1",
    refundBasis: policy.refundBasis,
    simulated: true,
    demoOnly: true,
  };
  const cancellationPolicySnapshot = {
    ...policy,
    guestAcceptedCancellationTerms: true,
    guestAcceptedCancellationTermsAt: acceptedAt,
    guestAcceptedCancellationTermsText: termsText,
    guestAcceptedCancellationTermsSource: "INTERNAL_DEMO_CENTER",
    cancellationTermsAckVersion: "cancellation_terms_ack_v1",
    cancellationPolicyRefundBasis: policy.refundBasis,
    cancellationTermsAcceptance,
  };

  const guestToken = await ensureGuestToken(prisma, reservation.id);

  const updated = await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      source: "INTERNAL_DEMO_DIRECT_BOOKING",
      preferredLanguage: input.preferredLanguage,
      cancellationPolicyId: policy.policyId,
      cancellationPolicySnapshot: cancellationPolicySnapshot as any,
      externalRaw: {
        ...((reservation.externalRaw &&
        typeof reservation.externalRaw === "object" &&
        !Array.isArray(reservation.externalRaw))
          ? (reservation.externalRaw as Record<string, unknown>)
          : {}),
        demoDirectBookingParity: {
          enabled: true,
          simulated: true,
          paymentSimulated: true,
          appliedAt: acceptedAt,
        },
      } as any,
    },
    select: {
      id: true,
      reservationNumber: true,
      guestToken: true,
      guestName: true,
      guestEmail: true,
      guestPhone: true,
      checkIn: true,
      checkOut: true,
      totalAmount: true,
      currency: true,
      hostPayoutStatus: true,
      identityVerificationRequiredSnapshot: true,
    },
  });

  const reservationNumber = updated.reservationNumber ?? updated.id;
  const manageReservationUrl = buildManageReservationUrl(guestToken);
  const verificationUrl = buildGuestVerificationUrl(guestToken);
  const presentation = renderCancellationPolicySnapshot({
    snapshot: policy,
    preferredLanguage: input.preferredLanguage,
    checkIn: updated.checkIn,
  });
  const totalAmount =
    updated.totalAmount === null ? null : Number(updated.totalAmount);

  let guestEmail: any = {
    attempted: false,
    ok: false,
    status: "NOT_ATTEMPTED",
    to: updated.guestEmail,
  };

  if (updated.guestEmail) {
    const replyTo = await resolveOrganizationGuestReplyTo(
      prisma,
      reservation.property.organizationId
    );

    const payload = {
      to: updated.guestEmail,
      replyTo: replyTo.email,
      reservationNumber,
      guestName: updated.guestName,
      propertyName: reservation.property.name,
      checkIn: updated.checkIn,
      checkOut: updated.checkOut,
      propertyTimeZone: reservation.property.timezone,
      totalAmount,
      currency: updated.currency,
      manageReservationUrl,
      verificationUrl,
      identityVerificationRequired:
        updated.identityVerificationRequiredSnapshot !== false,
      cancellationPolicyName: policy.name,
      cancellationPolicyType: policy.type,
      cancellationPolicySummary: getPolicySummary(policy),
      refundBasis: policy.refundBasis,
      refundRules: getRefundRules(policy),
      cancellationPolicyPresentation: presentation,
      preferredLanguage: input.preferredLanguage,
    };

    const result = await sendLoggedEmail({
      prisma,
      type: "DIRECT_BOOKING_GUEST_CONFIRMATION",
      to: updated.guestEmail,
      subject:
        `${input.preferredLanguage === "es" ? "Reservación confirmada" : "Reservation confirmed"} #${reservationNumber} - ${reservation.property.name}`,
      reservationId: updated.id,
      propertyId: reservation.property.id,
      organizationId: reservation.property.organizationId,
      retryPayload: payload,
      send: () => sendDirectBookingGuestConfirmation(payload),
    });

    guestEmail = {
      attempted: true,
      ok: result.ok,
      status: result.status,
      error: result.error ?? null,
      to: updated.guestEmail,
    };
  }

  const admins = await prisma.dashboardUser.findMany({
    where: {
      organizationId: reservation.property.organizationId,
      isActive: true,
      role: DashboardUserRole.ORG_ADMIN,
    },
    select: { email: true, fullName: true },
    orderBy: { createdAt: "asc" },
  });
  const hostRecipients =
    admins.length > 0
      ? admins
      : await prisma.dashboardUser.findMany({
          where: {
            organizationId: reservation.property.organizationId,
            isActive: true,
          },
          select: { email: true, fullName: true },
          orderBy: { createdAt: "asc" },
        });

  const hostEmail = {
    attempted: hostRecipients.length > 0,
    sent: 0,
    failed: 0,
  };

  const seen = new Set<string>();
  for (const recipient of hostRecipients) {
    const to = String(recipient.email ?? "").trim().toLowerCase();
    if (!to || seen.has(to)) continue;
    seen.add(to);

    const payload = {
      to,
      reservationNumber,
      hostName: recipient.fullName,
      propertyName: reservation.property.name,
      guestName: updated.guestName ?? "Guest",
      guestEmail: updated.guestEmail,
      guestPhone: updated.guestPhone,
      checkIn: updated.checkIn,
      checkOut: updated.checkOut,
      propertyTimeZone: reservation.property.timezone,
      totalAmount,
      currency: updated.currency,
      paymentState: "PAID",
      hostPayoutStatus: "DEMO_SIMULATED",
    };

    const result = await sendLoggedEmail({
      prisma,
      type: "DIRECT_BOOKING_HOST_NOTIFICATION",
      to,
      subject: `New Reservation #${reservationNumber} - ${reservation.property.name}`,
      reservationId: updated.id,
      propertyId: reservation.property.id,
      organizationId: reservation.property.organizationId,
      retryPayload: payload,
      send: () => sendDirectBookingHostNotification(payload as any),
    });

    if (result.ok) hostEmail.sent += 1;
    else hostEmail.failed += 1;
  }

  return {
    reservationId: updated.id,
    reservationNumber,
    guestTokenReady: Boolean(updated.guestToken),
    manageReservationUrl,
    verificationUrl,
    guestEmail,
    hostEmail,
    payment: {
      state: "PAID",
      simulated: true,
      charged: false,
    },
  };
}
