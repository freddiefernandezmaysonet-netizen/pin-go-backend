import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { checkPropertyAvailability } from "./availability.service";
import { ingestReservation } from "./ingest.service";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";
import { syncChannexAvailabilityForProperty } from "./channex-availability-sync.service";
import {
  sendDirectBookingGuestConfirmation,
  sendDirectBookingHostNotification,
} from "../lib/mailer";

const prisma = new PrismaClient();

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
  const guestPhone = String(session.metadata?.guestPhone ?? "").trim() || null;

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

if (!stayNotificationsConsent || !smsConsent) {
  throw new Error("DIRECT_BOOKING_SMS_CONSENT_REQUIRED");
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
      acceptedAt: new Date().toISOString(),
   },
 },

  status: "ACTIVE",
});

const updatedReservation = await prisma.reservation.update({
  where: {
    id: ingestResult.reservationId,
  },
  data: {
    totalAmount: pricingBreakdown.totalAmount,
    currency: pricingBreakdown.currency,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: paymentIntentId,
    selectedAmenityIds,
    pricingBreakdown,
    },
  select: {
    id: true,
    guestName: true,
    guestEmail: true,
    guestPhone: true,
    checkIn: true,
    checkOut: true,
    totalAmount: true,
    currency: true,
  },
});

const amountNumber = updatedReservation.totalAmount
  ? Number(updatedReservation.totalAmount)
  : null;

if (updatedReservation.guestEmail) {
  try {
    await sendDirectBookingGuestConfirmation({
      to: updatedReservation.guestEmail,
      guestName: updatedReservation.guestName,
      propertyName: property.name,
      checkIn: updatedReservation.checkIn,
      checkOut: updatedReservation.checkOut,
      totalAmount: amountNumber,
      currency: updatedReservation.currency,
    });
  } catch (emailError) {
    console.error("[DIRECT_BOOKING_GUEST_EMAIL_ERROR]", emailError);
  }
}

try {
  await syncChannexAvailabilityForProperty(property.id);

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });
} catch (syncError: any) {
  console.error("[DIRECT_BOOKING_CHANNEX_SYNC_ERROR]", syncError);

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastError:
        syncError?.message || "Failed to sync Channex after direct booking",
    },
  });
}

return {
  id: ingestResult.reservationId,
  stripeCheckoutSessionId: session.id,
};

}