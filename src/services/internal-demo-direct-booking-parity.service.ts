import { DashboardUserRole, PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import {
  sendDirectBookingGuestConfirmation,
  sendDirectBookingHostNotification,
} from "../lib/mailer";
import { sendInternalDemoMessage } from "./internal-demo-message.service";
import { isInternalDemo } from "./internal-demo-scope";
import { generateReservationNumber } from "./reservation-number.service";
import {
  buildCancellationPolicySnapshot,
  buildGuestCancellationTermsText,
  renderCancellationPolicySnapshot,
} from "./cancellation-policy.service";
import {
  resolveOrganizationGuestReplyTo,
  resolveOrganizationPrimaryAdmin,
} from "./organization-guest-email.service";

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
  },
  providers = { guest: sendDirectBookingGuestConfirmation, host: sendDirectBookingHostNotification }
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    include: {
      property: {
        select: {
          id: true,
          status: true,
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

  if (!isInternalDemo(reservation)) throw new Error("INTERNAL_DEMO_RESERVATION_REQUIRED");
  const primaryAdmin = await resolveOrganizationPrimaryAdmin(prisma, reservation.property.organizationId);
  const approvedEmail = (reservation.externalRaw as any)?.demoRun?.primaryAdminEmail;
  if (!primaryAdmin || (approvedEmail && primaryAdmin.email.toLowerCase() !== approvedEmail)) {
    throw new Error("INTERNAL_DEMO_PRIMARY_ADMIN_CHANGED");
  }
  const policy = reservation.cancellationPolicySnapshot
    ? reservation.cancellationPolicySnapshot as any
    : await buildCancellationPolicySnapshot(reservation.propertyId);
  const acceptedAt = (reservation.cancellationPolicySnapshot as any)?.guestAcceptedCancellationTermsAt ?? new Date().toISOString();
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
  const canonicalReservationNumber =
    reservation.reservationNumber ??
    (await generateReservationNumber(prisma));

  const updated = await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      source: "INTERNAL_DEMO_DIRECT_BOOKING",
      reservationNumber: canonicalReservationNumber,
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
      demoSimulation: true,
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

    const result = await sendInternalDemoMessage({
      prisma,
      type: "DIRECT_BOOKING_GUEST_CONFIRMATION",
      to: updated.guestEmail,
      channel: "email",
      body: JSON.stringify({ kind: "INTERNAL_DEMO_CONFIRMATION", reservationNumber }),
      reservationId: updated.id,
      propertyId: reservation.property.id,
      organizationId: reservation.property.organizationId,
      send: () => providers.guest(payload),
    });

    guestEmail = {
      attempted: true,
      ok: result.ok,
      status: result.status,
      error: result.ok ? null : result.status,
      to: updated.guestEmail,
    };
  }

  const hostRecipients = [primaryAdmin];

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
      demoSimulation: true,
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

    const result = await sendInternalDemoMessage({
      prisma,
      type: "DIRECT_BOOKING_HOST_NOTIFICATION",
      to,
      channel: "email",
      body: JSON.stringify({ kind: "INTERNAL_DEMO_HOST_NOTIFICATION", reservationNumber }),
      reservationId: updated.id,
      propertyId: reservation.property.id,
      organizationId: reservation.property.organizationId,
      send: () => providers.host(payload as any),
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
