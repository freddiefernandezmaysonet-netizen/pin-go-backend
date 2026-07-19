import Stripe from "stripe";
import { randomBytes } from "crypto";
import {
  DashboardUserRole,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import stripe from "../billing/stripe";
import { checkPropertyAvailability } from "./availability.service";
import { ingestReservation } from "./ingest.service";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";
import { syncChannexAvailabilityForProperty } from "./channex-availability-sync.service";
import { auditReservationCompleteFlowSafe } from "./reservation-complete-flow-audit.service";
import { sendLoggedEmail } from "./email-delivery.service";
import type { AuditEntry } from "../apms/audit-types";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import {
  sendDirectBookingGuestConfirmation,
  sendDirectBookingHostNotification,
} from "../lib/mailer";
import { deserializeCancellationPolicySnapshotFromStripeMetadata } from "./cancellation-policy.service";
import { dispatchPendingCleaningConfirmationForReservation } from "./cleaning-confirmation-dispatch.service";

const prisma = new PrismaClient();

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
  return `${getPublicApiUrl()}/guest/verify/${encodeURIComponent(
    guestToken
  )}`;
}

function requiredMetadata(session: Stripe.Checkout.Session, key: string) {
  const value = String(session.metadata?.[key] ?? "").trim();

  if (!value) {
    throw new Error(`Missing direct booking metadata: ${key}`);
  }

  return value;
}

function parseDateMetadata(session: Stripe.Checkout.Session, key: string) {
  const value = requiredMetadata(session, key);
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid direct booking date metadata: ${key}`);
  }

  return date;
}

function parseSelectedAmenityIds(session: Stripe.Checkout.Session) {
  const raw = String(session.metadata?.selectedAmenityIds ?? "").trim();

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed.map((id) => String(id)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function parsePricingBreakdown(session: Stripe.Checkout.Session) {
  const raw = String(session.metadata?.pricingBreakdown ?? "").trim();

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function optionalMetadata(session: Stripe.Checkout.Session, key: string) {
  return String(session.metadata?.[key] ?? "").trim() || null;
}

function parseOptionalMoneyMetadata(
  session: Stripe.Checkout.Session,
  key: string
) {
  const raw = optionalMetadata(session, key);

  if (!raw) return null;

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Number(value.toFixed(2));
}

function parseHostPayoutStatus(session: Stripe.Checkout.Session) {
  const raw = optionalMetadata(session, "hostPayoutStatus");

  const allowedStatuses = new Set([
    "NOT_APPLICABLE",
    "BLOCKED",
    "PENDING_CONNECT",
    "ROUTED_TO_CONNECT",
    "PAID_TO_HOST",
    "PARTIALLY_REFUNDED",
    "FAILED",
    "REFUNDED",
  ]);

  if (raw && allowedStatuses.has(raw)) {
    return raw;
  }

  return optionalMetadata(session, "stripeConnectedAccountId")
    ? "ROUTED_TO_CONNECT"
    : "NOT_APPLICABLE";
}

async function getStripeFinancialRefs(paymentIntentId: string | null) {
  const emptyRefs = {
    stripeChargeId: null as string | null,
    stripeTransferId: null as string | null,
    stripeApplicationFeeId: null as string | null,
  };

  if (!paymentIntentId) {
    return emptyRefs;
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: [
        "latest_charge",
        "latest_charge.transfer",
        "latest_charge.application_fee",
      ],
    });

    const latestCharge = paymentIntent.latest_charge;

    if (!latestCharge) {
      return emptyRefs;
    }

    if (typeof latestCharge === "string") {
      return {
        ...emptyRefs,
        stripeChargeId: latestCharge,
      };
    }

    const chargeAny = latestCharge as any;

    return {
      stripeChargeId: latestCharge.id ?? null,
      stripeTransferId:
        typeof chargeAny.transfer === "string"
          ? chargeAny.transfer
          : chargeAny.transfer?.id ?? null,
      stripeApplicationFeeId:
        typeof chargeAny.application_fee === "string"
          ? chargeAny.application_fee
          : chargeAny.application_fee?.id ?? null,
    };
  } catch (error: any) {
    console.error("[DIRECT_BOOKING_STRIPE_FINANCIAL_REFS_ERROR]", {
      paymentIntentId,
      error: error?.message ?? error,
    });

    return emptyRefs;
  }
}

function createGuestToken() {
  return randomBytes(32).toString("hex");
}

function getAppUrl() {
  return String(process.env.APP_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
}

function buildManageReservationUrl(guestToken: string) {
  return `${getAppUrl()}/booking/manage/${encodeURIComponent(guestToken)}`;
}

type HostNotificationRecipient = {
  email: string;
  fullName: string | null;
};

async function getHostNotificationRecipients(organizationId: string) {
  const adminUsers = await prisma.dashboardUser.findMany({
    where: {
      organizationId,
      isActive: true,
      role: DashboardUserRole.ORG_ADMIN,
    },
    select: {
      email: true,
      fullName: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  const users =
    adminUsers.length > 0
      ? adminUsers
      : await prisma.dashboardUser.findMany({
          where: {
            organizationId,
            isActive: true,
          },
          select: {
            email: true,
            fullName: true,
          },
          orderBy: {
            createdAt: "asc",
          },
        });

  const seenEmails = new Set<string>();
  const recipients: HostNotificationRecipient[] = [];

  for (const user of users) {
    const email = String(user.email ?? "").trim().toLowerCase();

    if (!email || seenEmails.has(email)) {
      continue;
    }

    seenEmails.add(email);

    recipients.push({
      email,
      fullName: user.fullName,
    });
  }

  return recipients;
}

async function sendDirectBookingHostNotificationSafe({
  organizationId,
  propertyId,
  propertyName,
  propertyTimeZone,
  reservation,
  totalAmount,
}: {
  organizationId: string;
  propertyId: string;
  propertyName: string;
  propertyTimeZone?: string | null;
  reservation: {
    id: string;
    reservationNumber: string;
    guestName: string | null;
    guestEmail: string | null;
    guestPhone: string | null;
    checkIn: Date;
    checkOut: Date;
    currency: string | null;
    hostPayoutStatus: unknown;
  };
  totalAmount: number | null;
}) {
  const recipients = await getHostNotificationRecipients(organizationId);

  if (recipients.length === 0) {
    console.warn("[HOST_BOOKING_EMAIL_NO_RECIPIENTS]", {
      organizationId,
      propertyId,
      reservationId: reservation.id,
    });

    return {
      ok: true,
      sent: 0,
      skipped: true,
    };
  }

  let sent = 0;

for (const recipient of recipients) {
  const directBookingHostEmailInput = {
    to: recipient.email,
    reservationNumber: reservation.reservationNumber,
    hostName: recipient.fullName,
    propertyName,
    guestName: reservation.guestName ?? "Guest",
    guestEmail: reservation.guestEmail,
    guestPhone: reservation.guestPhone,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    propertyTimeZone,
    totalAmount,
    currency: reservation.currency,
    paymentState: "PAID",
    hostPayoutStatus: String(reservation.hostPayoutStatus ?? ""),
  };

  const hostEmailDeliveryResult = await sendLoggedEmail({
    prisma,
    type: "DIRECT_BOOKING_HOST_NOTIFICATION",
    to: recipient.email,
    subject: `New Reservation #${reservation.reservationNumber} - ${propertyName}`,
    reservationId: reservation.id,
    propertyId,
    organizationId,
    retryPayload: directBookingHostEmailInput,
    send: () =>
      sendDirectBookingHostNotification(
        directBookingHostEmailInput as any
      ),
  });

  if (hostEmailDeliveryResult.ok) {
    sent += 1;
  } else {
    console.error("[DIRECT_BOOKING_HOST_EMAIL_DELIVERY_FAILED]", {
      organizationId,
      propertyId,
      reservationId: reservation.id,
      to: recipient.email,
      status: hostEmailDeliveryResult.status,
      error: hostEmailDeliveryResult.error,
    });
  }
}
  return {
    ok: true,
    sent,
    skipped: false,
  };
}

async function getOrCreateReservationGuestToken(reservationId: string) {
  const existingReservation = await prisma.reservation.findUnique({
    where: {
      id: reservationId,
    },
    select: {
      guestToken: true,
    },
  });

  if (existingReservation?.guestToken) {
    return existingReservation.guestToken;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const guestToken = createGuestToken();

    try {
      const updatedReservation = await prisma.reservation.update({
        where: {
          id: reservationId,
        },
        data: {
          guestToken,
        },
        select: {
          guestToken: true,
        },
      });

      if (updatedReservation.guestToken) {
        return updatedReservation.guestToken;
      }
    } catch (error: any) {
      if (error?.code !== "P2002") {
        throw error;
      }
    }
  }

  throw new Error("DIRECT_BOOKING_GUEST_TOKEN_CREATE_FAILED");
}

function getCancellationPolicySummaryForEmail(snapshot: any) {
  const guestFacingSummary = String(snapshot?.guestFacingSummary ?? "").trim();

  if (guestFacingSummary) {
    return guestFacingSummary;
  }

  const description = String(snapshot?.description ?? "").trim();

  return description || null;
}

function getCancellationRefundRulesForEmail(snapshot: any) {
  const refundRules = Array.isArray(snapshot?.refundRules)
    ? snapshot.refundRules
    : [];

  return refundRules
    .map((rule: any) => {
      const minHoursBeforeCheckIn = Math.max(
        0,
        Math.round(Number(rule?.minHoursBeforeCheckIn ?? 0))
      );
      const refundPercent = Math.max(
        0,
        Math.min(100, Number(rule?.refundPercent ?? 0))
      );
      const label = String(
        rule?.label ?? `${Number(refundPercent.toFixed(2))}% refund`
      )
        .trim()
        .slice(0, 80);
      const description =
        typeof rule?.description === "string" && rule.description.trim()
          ? rule.description.trim().slice(0, 280)
          : null;

      if (!Number.isFinite(minHoursBeforeCheckIn) || !Number.isFinite(refundPercent)) {
        return null;
      }

      return {
        minHoursBeforeCheckIn,
        refundPercent: Number(refundPercent.toFixed(2)),
        label: label || `${Number(refundPercent.toFixed(2))}% refund`,
        description,
      };
    })
    .filter(
      (rule): rule is {
        minHoursBeforeCheckIn: number;
        refundPercent: number;
        label: string;
        description: string | null;
      } => Boolean(rule)
    );
}

export async function handleDirectBookingCheckoutCompleted(
  session: Stripe.Checkout.Session
) {
  if (session.metadata?.flow !== "direct_booking") {
    return null;
  }

  const existing = await prisma.reservation.findUnique({
    where: {
      stripeCheckoutSessionId: session.id,
    },
    select: {
      id: true,
      stripeCheckoutSessionId: true,
    },
  });

  if (existing) {
    return existing;
  }

  const propertyId = requiredMetadata(session, "propertyId");
  const organizationId = requiredMetadata(session, "organizationId");
  const guestName = requiredMetadata(session, "guestName");
  const guestEmail = requiredMetadata(session, "guestEmail");
  const guestPhone = 
    String(session.metadata?.guestPhone ?? "").trim() || null;
  const preferredLanguage =
    String(session.metadata?.preferredLanguage ?? "")
      .trim()
      .toLowerCase() === "es"
      ? "es"
      : "en";
  
  const stayNotificationsConsent =
    String(session.metadata?.stayNotificationsConsent ?? "").trim() === "true";

  const smsConsent =
    String(session.metadata?.smsConsent ?? "").trim() === "true";

  const consentSource =
    String(session.metadata?.consentSource ?? "").trim() ||
    "DIRECT_BOOKING_WEB_FORM";

  const consentVersion =
    String(session.metadata?.consentVersion ?? "").trim() ||
    "stay_notifications_v1";

  const cancellationTermsAccepted =
    String(session.metadata?.guestAcceptedCancellationTerms ?? "").trim() ===
    "true";

  const cancellationTermsAcceptedAtRaw = optionalMetadata(
    session,
    "guestAcceptedCancellationTermsAt"
  );

  const cancellationTermsAcceptedAt =
    cancellationTermsAcceptedAtRaw &&
    !Number.isNaN(new Date(cancellationTermsAcceptedAtRaw).getTime())
      ? cancellationTermsAcceptedAtRaw
      : new Date().toISOString();

const cancellationTermsText = optionalMetadata(
  session,
  "guestAcceptedCancellationTermsText"
);

const cancellationTermsSource =
  optionalMetadata(session, "guestAcceptedCancellationTermsSource") ??
  "DIRECT_BOOKING_WEB_FORM";

const cancellationTermsAckVersion =
  optionalMetadata(session, "cancellationTermsAckVersion") ??
  "cancellation_terms_ack_v1";

const cancellationPolicyRefundBasis = optionalMetadata(
  session,
  "cancellationPolicyRefundBasis"
);

const securePreCheckinDisclosureAccepted =
  String(
    session.metadata?.securePrecheckinAccepted ??
      session.metadata?.guestAcceptedSecurePreCheckinRequirement ??
      ""
  ).trim() === "true";

const securePreCheckinDisclosureAcceptedAtRaw =
  optionalMetadata(session, "securePrecheckinAcceptedAt") ??
  optionalMetadata(
    session,
    "guestAcceptedSecurePreCheckinRequirementAt"
  );

const securePreCheckinDisclosureAcceptedAt =
  securePreCheckinDisclosureAcceptedAtRaw &&
  !Number.isNaN(
    new Date(securePreCheckinDisclosureAcceptedAtRaw).getTime()
  )
    ? securePreCheckinDisclosureAcceptedAtRaw
    : new Date().toISOString();

const securePreCheckinDisclosureText =
  optionalMetadata(session, "securePrecheckinText") ??
  optionalMetadata(
    session,
    "guestAcceptedSecurePreCheckinRequirementText"
  );

const securePreCheckinDisclosureVersion =
  optionalMetadata(session, "securePrecheckinVersion") ??
  optionalMetadata(
    session,
    "guestAcceptedSecurePreCheckinRequirementVersion"
  ) ?? "secure_precheckin_disclosure_v1";

const securePreCheckinDisclosureSource =
  optionalMetadata(session, "securePrecheckinSource") ??
  optionalMetadata(
    session,
    "guestAcceptedSecurePreCheckinRequirementSource"
  ) ?? "DIRECT_BOOKING_WEB_FORM";

if (!cancellationTermsAccepted || !cancellationTermsText) {
  throw new Error("DIRECT_BOOKING_CANCELLATION_TERMS_ACK_REQUIRED");
}

if (
  !securePreCheckinDisclosureAccepted ||
  !securePreCheckinDisclosureText
) {
  throw new Error(
    "DIRECT_BOOKING_SECURE_PRECHECKIN_DISCLOSURE_ACK_REQUIRED"
  );
}
  const checkIn = parseDateMetadata(session, "checkIn");
  const checkOut = parseDateMetadata(session, "checkOut");
  const checkInRaw = requiredMetadata(session, "checkIn");
  const checkOutRaw = requiredMetadata(session, "checkOut");

  const property = await prisma.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
      status: "ACTIVE",
      isPublicBookable: true,
      organization: {
        publicBookingEnabled: true,
      },
    },
    select: {
  id: true,
  name: true,
  timezone: true,
  organizationId: true,
  },

  });

  if (!property) {
    throw new Error("DIRECT_BOOKING_PROPERTY_NOT_FOUND_OR_NOT_PUBLIC");
  }

  const availability = await checkPropertyAvailability({
    propertyId: property.id,
    checkIn,
    checkOut,
  });

  if (!availability.available) {
    throw new Error("DIRECT_BOOKING_PROPERTY_NO_LONGER_AVAILABLE");
  }

  const totalAmountRaw =
    String(session.metadata?.totalAmount ?? "").trim() ||
    String((session.amount_total ?? 0) / 100);

  const totalAmount = Number(totalAmountRaw);

  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("DIRECT_BOOKING_INVALID_TOTAL_AMOUNT");
  }

 const paymentIntentId =
  typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;

const deserializedCancellationPolicySnapshot =
  deserializeCancellationPolicySnapshotFromStripeMetadata(
    session.metadata?.cancellationPolicySnapshot
  );

const securePreCheckinDisclosureAcceptance = {
  accepted: true,
  acceptedAt: securePreCheckinDisclosureAcceptedAt,
  text: securePreCheckinDisclosureText,
  version: securePreCheckinDisclosureVersion,
  source: securePreCheckinDisclosureSource,
};

const cancellationTermsAcceptance = {
  accepted: true,
  acceptedAt: cancellationTermsAcceptedAt,
  text: cancellationTermsText,
  source: cancellationTermsSource,
  version: cancellationTermsAckVersion,
  refundBasis:
    (deserializedCancellationPolicySnapshot as any)?.refundBasis ??
    cancellationPolicyRefundBasis ??
    null,
};
const cancellationPolicySnapshot = {
  ...(deserializedCancellationPolicySnapshot ?? {}),
  refundBasis: cancellationTermsAcceptance.refundBasis,
  guestAcceptedCancellationTerms: true,
  guestAcceptedCancellationTermsAt: cancellationTermsAcceptance.acceptedAt,
  guestAcceptedCancellationTermsText: cancellationTermsAcceptance.text,
  guestAcceptedCancellationTermsSource: cancellationTermsAcceptance.source,
  cancellationTermsAckVersion: cancellationTermsAcceptance.version,
  cancellationPolicyRefundBasis: cancellationTermsAcceptance.refundBasis,
  cancellationTermsAcceptance,
};

let cancellationPolicyId: string | null = null;

if ((cancellationPolicySnapshot as any)?.policyId) {
  const existingCancellationPolicy =
    await prisma.propertyCancellationPolicy.findFirst({
      where: {
        id: (cancellationPolicySnapshot as any).policyId,
        propertyId: property.id,
      },
      select: {
        id: true,
      },
    });

  cancellationPolicyId = existingCancellationPolicy?.id ?? null;
}

const stripeConnectedAccountId = optionalMetadata(
  session,
  "stripeConnectedAccountId"
);

const platformFeeAmount = parseOptionalMoneyMetadata(
  session,
  "platformFeeAmount"
);

const basePlatformFeeAmount = parseOptionalMoneyMetadata(
  session,
  "basePlatformFeeAmount"
);

const directBookingProtectionFeeAmount = parseOptionalMoneyMetadata(
  session,
  "directBookingProtectionFeeAmount"
);

const identityVerificationRequiredSnapshot =
  optionalMetadata(session, "identityVerificationRequired") === "true";

const hostPayoutAmount = parseOptionalMoneyMetadata(
  session,
  "hostPayoutAmount"
);

const hostPayoutStatus = parseHostPayoutStatus(session);

const stripeFinancialRefs = await getStripeFinancialRefs(paymentIntentId);

const selectedAmenityIds = parseSelectedAmenityIds(session);
const pricingBreakdown = await calculateDirectBookingPricing({
  propertyId: property.id,
  checkIn,
  checkOut,
  selectedAmenityIds,
});

const ingestResult = await ingestReservation({
  source: "DIRECT_BOOKING",

  propertyId: property.id,
  guestName,
  guestEmail,
  guestPhone,
  preferredLanguage,
  roomName: property.name,

  checkIn: checkInRaw,
  checkOut: checkOutRaw,
 
  paymentState: "PAID",

  externalProvider: "PIN_GO_DIRECT",
  externalId: session.id,
  externalUpdatedAt: new Date().toISOString(),
  externalRaw: {
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: paymentIntentId,
    amountTotal: session.amount_total,
    currency: session.currency,
    metadata: session.metadata ?? {},
   consent: {
  stayNotificationsConsent,
  smsConsent,
  consentSource,
  consentVersion,
  acceptedAt: smsConsent ? new Date().toISOString() : null,
},
    cancellationTerms: cancellationTermsAcceptance,
 },

  status: "ACTIVE",
});

const guestToken = await getOrCreateReservationGuestToken(
  ingestResult.reservationId
);
const manageReservationUrl = buildManageReservationUrl(guestToken);

const pricingBreakdownJson = JSON.parse(
  JSON.stringify(pricingBreakdown)
) as Prisma.InputJsonValue;

const updatedReservation = await prisma.reservation.update({
  where: {
    id: ingestResult.reservationId,
  },
 data: {
  totalAmount: pricingBreakdown.totalAmount,
  currency: pricingBreakdown.currency,
  stripeCheckoutSessionId: session.id,
  stripePaymentIntentId: paymentIntentId,

  cancellationPolicyId,
  cancellationPolicySnapshot: cancellationPolicySnapshot as any,
  securePreCheckinDisclosureAcceptance:
    securePreCheckinDisclosureAcceptance as any, 
  stripeConnectedAccountId,
  stripeChargeId: stripeFinancialRefs.stripeChargeId,
  stripeTransferId: stripeFinancialRefs.stripeTransferId,
  stripeApplicationFeeId: stripeFinancialRefs.stripeApplicationFeeId,
  basePlatformFeeAmount,
  platformFeeAmount,
  hostPayoutAmount,
  hostPayoutStatus: hostPayoutStatus as any,
  hostPayoutLastSyncedAt: new Date(),
  directBookingProtectionFeeAmount,
  identityVerificationRequiredSnapshot,

  selectedAmenityIds,
  pricingBreakdown: pricingBreakdownJson,
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
  stripeConnectedAccountId: true,
  basePlatformFeeAmount: true,
  platformFeeAmount: true,
  hostPayoutAmount: true,
  hostPayoutStatus: true,
},
});

const amountNumber = updatedReservation.totalAmount
  ? Number(updatedReservation.totalAmount)
  : null;

const verificationUrl =
  updatedReservation.guestToken
    ? buildGuestVerificationUrl(
        updatedReservation.guestToken
      )
    : null;

if (updatedReservation.guestEmail) {
  const directBookingGuestEmailInput = {
    to: updatedReservation.guestEmail,
    reservationNumber: updatedReservation.reservationNumber,
    guestName: updatedReservation.guestName,
    propertyName: property.name,
    checkIn: updatedReservation.checkIn,
    checkOut: updatedReservation.checkOut,
    propertyTimeZone: property.timezone,
    totalAmount: amountNumber,
    currency: updatedReservation.currency,
    manageReservationUrl,
    verificationUrl,
    cancellationPolicyName: (cancellationPolicySnapshot as any).name ?? null,
    cancellationPolicyType: (cancellationPolicySnapshot as any).type ?? null,
    cancellationPolicySummary: getCancellationPolicySummaryForEmail(
      cancellationPolicySnapshot
    ),
    refundBasis: (cancellationPolicySnapshot as any).refundBasis ?? null,
    refundRules: getCancellationRefundRulesForEmail(
      cancellationPolicySnapshot
    ),
    preferredLanguage,
  };

  const guestEmailDeliveryResult = await sendLoggedEmail({
    prisma,
    type: "DIRECT_BOOKING_GUEST_CONFIRMATION",
    to: updatedReservation.guestEmail,
    subject:
      `${preferredLanguage === "es" ? "Reservación confirmada" : "Reservation confirmed"} #${updatedReservation.reservationNumber} - ${property.name}`,
    reservationId: updatedReservation.id,
    propertyId: property.id,
    organizationId: property.organizationId,
    retryPayload: directBookingGuestEmailInput,
    send: () => sendDirectBookingGuestConfirmation(directBookingGuestEmailInput),
  });

  if (!guestEmailDeliveryResult.ok) {
    console.error("[DIRECT_BOOKING_GUEST_EMAIL_DELIVERY_FAILED]", {
      organizationId: property.organizationId,
      propertyId: property.id,
      reservationId: updatedReservation.id,
      to: updatedReservation.guestEmail,
      status: guestEmailDeliveryResult.status,
      error: guestEmailDeliveryResult.error,
    });
  }
}

await sendDirectBookingHostNotificationSafe({
  organizationId: property.organizationId,
  propertyId: property.id,
  propertyName: property.name,
  propertyTimeZone: property.timezone,
  reservation: updatedReservation,
  totalAmount: amountNumber,
});

const distributionStartedAt = new Date();
const distributionDecisionId = `distribution-engine:${property.id}:direct-booking:${ingestResult.reservationId}`;

let distributionSyncResult: any = null;

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(
    property.id
  );

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });

  const distributionCompletedAt = new Date();

  const distributionSyncSucceeded =
    distributionSyncResult &&
    typeof distributionSyncResult === "object" &&
    "ok" in distributionSyncResult
      ? Boolean((distributionSyncResult as any).ok)
      : true;

  const distributionAuditEntry: AuditEntry = {
    engine: "Distribution",
    decisionId: distributionDecisionId,
    entityType: "DISTRIBUTION",
    entityId: property.id,
    eventType: distributionSyncSucceeded
      ? "SYNC_COMPLETED"
      : "SYNC_FAILED",
    status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
    severity: distributionSyncSucceeded ? "INFO" : "WARNING",
    summary: distributionSyncSucceeded
      ? "Distribution Engine synchronized channel availability after direct booking reservation."
      : "Distribution Engine could not fully synchronize channel availability after direct booking reservation.",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    durationMs:
      distributionCompletedAt.getTime() - distributionStartedAt.getTime(),
    reason: distributionSyncSucceeded
      ? "DIRECT_BOOKING_DISTRIBUTION_SYNC_COMPLETED"
      : "DIRECT_BOOKING_DISTRIBUTION_SYNC_FAILED",
    decisions: [
      {
        engine: "Distribution",
        rule: "DIRECT_BOOKING_CHANNEX_AVAILABILITY_SYNC",
        label: "Direct Booking Channel Availability Sync",
        applied: distributionSyncSucceeded,
        adjustment: null,
        adjustmentPercent: null,
        confidence: distributionSyncSucceeded ? 100 : 0,
        metadata: {
          organizationId: property.organizationId,
          propertyId: property.id,
          reservationId: ingestResult.reservationId,
          provider: "CHANNEX",
          syncType: "AVAILABILITY",
          trigger: "DIRECT_BOOKING",
          resultOk:
            distributionSyncResult &&
            typeof distributionSyncResult === "object" &&
            "ok" in distributionSyncResult
              ? (distributionSyncResult as any).ok
              : null,
          pushedToChannex:
            distributionSyncResult &&
            typeof distributionSyncResult === "object" &&
            "pushedToChannex" in distributionSyncResult
              ? (distributionSyncResult as any).pushedToChannex
              : null,
        },
      },
    ],
    recommendedAction: distributionSyncSucceeded
      ? undefined
      : "Review Channex sync after this direct booking reservation.",
    metadata: {
      organizationId: property.organizationId,
      propertyId: property.id,
      reservationId: ingestResult.reservationId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "DIRECT_BOOKING",
      resultOk:
        distributionSyncResult &&
        typeof distributionSyncResult === "object" &&
        "ok" in distributionSyncResult
          ? (distributionSyncResult as any).ok
          : null,
      pushedToChannex:
        distributionSyncResult &&
        typeof distributionSyncResult === "object" &&
        "pushedToChannex" in distributionSyncResult
          ? (distributionSyncResult as any).pushedToChannex
          : null,
    },
  };

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      reservationId: ingestResult.reservationId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "DIRECT_BOOKING",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} catch (syncError: any) {
  console.error("[DIRECT_BOOKING_CHANNEX_SYNC_ERROR]", syncError);

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastError:
        syncError?.message || "Failed to sync Channex after direct booking",
    },
  });

  const distributionCompletedAt = new Date();

  const distributionAuditEntry: AuditEntry = {
    engine: "Distribution",
    decisionId: distributionDecisionId,
    entityType: "DISTRIBUTION",
    entityId: property.id,
    eventType: "SYNC_FAILED",
    status: "FAILED",
    severity: "CRITICAL",
    summary:
      "Distribution Engine failed to synchronize channel availability after direct booking reservation.",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    durationMs:
      distributionCompletedAt.getTime() - distributionStartedAt.getTime(),
    reason: "DIRECT_BOOKING_DISTRIBUTION_SYNC_ERROR",
    decisions: [
      {
        engine: "Distribution",
        rule: "DIRECT_BOOKING_CHANNEX_AVAILABILITY_SYNC",
        label: "Direct Booking Channel Availability Sync",
        applied: false,
        adjustment: null,
        adjustmentPercent: null,
        confidence: 0,
        metadata: {
          organizationId: property.organizationId,
          propertyId: property.id,
          reservationId: ingestResult.reservationId,
          provider: "CHANNEX",
          syncType: "AVAILABILITY",
          trigger: "DIRECT_BOOKING",
          error: syncError?.message ?? String(syncError),
        },
      },
    ],
    recommendedAction:
      "Review Channex availability connection and retry sync after this direct booking reservation.",
    metadata: {
      organizationId: property.organizationId,
      propertyId: property.id,
      reservationId: ingestResult.reservationId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "DIRECT_BOOKING",
      error: syncError?.message ?? String(syncError),
    },
  };

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      reservationId: ingestResult.reservationId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "DIRECT_BOOKING",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
}

let cleaningConfirmationDispatchResult: any = null;

try {
  cleaningConfirmationDispatchResult =
    await dispatchPendingCleaningConfirmationForReservation({
      prisma,
      reservationId: ingestResult.reservationId,
    });

  console.log("[DIRECT_BOOKING_CLEANING_CONFIRMATION_DISPATCH_RESULT]", {
    reservationId: ingestResult.reservationId,
    sent: cleaningConfirmationDispatchResult?.sent ?? false,
    skipped: cleaningConfirmationDispatchResult?.skipped ?? false,
    reason: cleaningConfirmationDispatchResult?.reason ?? null,
    confirmationId: cleaningConfirmationDispatchResult?.confirmationId ?? null,
  });
} catch (cleaningDispatchError: any) {
  console.error("[DIRECT_BOOKING_CLEANING_CONFIRMATION_DISPATCH_ERROR]", {
    reservationId: ingestResult.reservationId,
    propertyId: property.id,
    organizationId: property.organizationId,
    error: cleaningDispatchError?.message ?? cleaningDispatchError,
  });
}

const completeFlowAuditResult = await auditReservationCompleteFlowSafe(
  ingestResult.reservationId,
  prisma
);

if (completeFlowAuditResult) {
  console.log("[RESERVATION_COMPLETE_FLOW_AUDIT_RESULT]", {
    reservationId: completeFlowAuditResult.reservationId,
    propertyId: completeFlowAuditResult.propertyId,
    organizationId: completeFlowAuditResult.organizationId,
    completeFlowStatus: completeFlowAuditResult.completeFlowStatus,
    failedChecks: completeFlowAuditResult.failedChecks.map((check) => check.rule),
    warningChecks: completeFlowAuditResult.warningChecks.map((check) => check.rule),
  });
}

return {
  id: ingestResult.reservationId,
  stripeCheckoutSessionId: session.id,
};

}
