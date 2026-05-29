import Stripe from "stripe";
import {
  PaymentState,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { checkPropertyAvailability } from "./availability.service";

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

  const checkIn = parseDateMetadata(session, "checkIn");
  const checkOut = parseDateMetadata(session, "checkOut");

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

  const reservation = await prisma.reservation.create({
    data: {
      propertyId: property.id,
      guestName,
      guestEmail,
      guestPhone,
      roomName: property.name,
      checkIn,
      checkOut,
      paymentState: PaymentState.PAID,
      totalAmount,
      currency: String(session.currency ?? "usd").toLowerCase(),
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      source: "DIRECT_BOOKING",
      externalProvider: "PIN_GO_DIRECT",
      externalId: session.id,
      externalRaw: {
        stripeCheckoutSessionId: session.id,
        amountTotal: session.amount_total,
        currency: session.currency,
        metadata: session.metadata ?? {},
      },
      status: ReservationStatus.ACTIVE,
    },
    select: {
      id: true,
      propertyId: true,
      checkIn: true,
      checkOut: true,
      status: true,
      paymentState: true,
      stripeCheckoutSessionId: true,
    },
  });

  return reservation;
}