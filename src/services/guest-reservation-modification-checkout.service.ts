import Stripe from "stripe";
import {
  PaymentState,
  PrismaClient,
  ReservationModificationFinancialAction,
  ReservationModificationStatus,
  ReservationStatus,
} from "@prisma/client";

import stripe from "../billing/stripe";
import { checkPropertyAvailability } from "./availability.service";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";
import {
  GuestReservationModificationError,
} from "./guest-reservation-modification.service";
import { assertDirectBookingPayoutReady } from "./stripe-connect.service";

const prisma = new PrismaClient();

function normalize(value: unknown) {
  return String(value ?? "").trim();
}

function getAppUrl() {
  return String(process.env.APP_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
}

function toCents(value: unknown, errorCode: string) {
  const amount = Number(value);
  const cents = Math.round(amount * 100);

  if (!Number.isFinite(amount) || !Number.isInteger(cents) || cents < 0) {
    throw new GuestReservationModificationError({
      code: errorCode,
      message: "The reservation modification amount is invalid.",
      statusCode: 409,
    });
  }

  return cents;
}

function assertValidModificationId(value: unknown) {
  const modificationId = normalize(value);

  if (!/^[A-Za-z0-9_-]{8,128}$/.test(modificationId)) {
    throw new GuestReservationModificationError({
      code: "INVALID_RESERVATION_MODIFICATION_ID",
      message: "A valid reservation modification ID is required.",
      statusCode: 400,
    });
  }

  return modificationId;
}

export function buildGuestReservationModificationCheckoutSessionParams(input: {
  modificationId: string;
  reservationId: string;
  propertyId: string;
  propertyName: string;
  guestEmail: string;
  preferredLanguage: string;
  connectedAccountId: string;
  additionalChargeAmountCents: number;
  additionalPlatformFeeAmountCents: number;
  additionalHostPayoutAmountCents: number;
  currency: string;
  expiresAt: Date;
  manageReservationUrl: string;
}) {
  const locale = input.preferredLanguage === "es" ? "es" : "en";
  const productName =
    locale === "es"
      ? `Modificación de reserva — ${input.propertyName}`
      : `Reservation modification — ${input.propertyName}`;
  const description =
    locale === "es"
      ? "Diferencia por cambios confirmados en tu estadía"
      : "Difference for confirmed changes to your stay";
  const paymentIntentData: Stripe.Checkout.SessionCreateParams.PaymentIntentData = {
    transfer_data: {
      destination: input.connectedAccountId,
    },
    metadata: {
      flow: "direct_booking_reservation_modification",
      reservationModificationId: input.modificationId,
      reservationId: input.reservationId,
      propertyId: input.propertyId,
    },
  };

  if (input.additionalPlatformFeeAmountCents > 0) {
    paymentIntentData.application_fee_amount =
      input.additionalPlatformFeeAmountCents;
  }

  const successUrl = new URL(input.manageReservationUrl);
  successUrl.searchParams.set("modificationPayment", "success");
  successUrl.searchParams.set("modificationId", input.modificationId);
  const cancelUrl = new URL(input.manageReservationUrl);
  cancelUrl.searchParams.set("modificationPayment", "cancelled");
  cancelUrl.searchParams.set("modificationId", input.modificationId);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    locale,
    client_reference_id: input.modificationId,
    customer_email: input.guestEmail,
    payment_intent_data: paymentIntentData,
    line_items: [
      {
        price_data: {
          currency: input.currency,
          product_data: {
            name: productName,
            description,
          },
          unit_amount: input.additionalChargeAmountCents,
        },
        quantity: 1,
      },
    ],
    expires_at: Math.floor(input.expiresAt.getTime() / 1000),
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
    metadata: {
      flow: "direct_booking_reservation_modification",
      reservationModificationId: input.modificationId,
      reservationId: input.reservationId,
      propertyId: input.propertyId,
      connectedAccountId: input.connectedAccountId,
      additionalChargeAmountCents: String(
        input.additionalChargeAmountCents
      ),
      additionalPlatformFeeAmountCents: String(
        input.additionalPlatformFeeAmountCents
      ),
      additionalHostPayoutAmountCents: String(
        input.additionalHostPayoutAmountCents
      ),
    },
  };

  return {
    params,
    idempotencyKey: `direct-booking-reservation-modification-checkout:${input.modificationId}`,
  };
}

function serializeCheckoutResult(input: {
  modificationId: string;
  status: ReservationModificationStatus;
  session: Stripe.Checkout.Session;
  additionalChargeAmountCents: number;
  currency: string;
  idempotentReplay: boolean;
}) {
  return {
    ok: true,
    modificationId: input.modificationId,
    modificationStatus: input.status,
    checkoutUrl: input.session.url,
    stripeCheckoutSessionId: input.session.id,
    stripePaymentStatus: input.session.payment_status,
    checkoutStatus: input.session.status,
    checkoutExpiresAt: new Date(input.session.expires_at * 1000),
    additionalChargeAmount: input.additionalChargeAmountCents / 100,
    additionalChargeAmountCents: input.additionalChargeAmountCents,
    currency: input.currency,
    idempotentReplay: input.idempotentReplay,
  };
}

export async function createGuestReservationModificationCheckout(input: {
  guestToken: string;
  modificationId: string;
}) {
  const guestToken = normalize(input.guestToken);
  const modificationId = assertValidModificationId(input.modificationId);

  if (!guestToken) {
    throw new GuestReservationModificationError({
      code: "MISSING_GUEST_TOKEN",
      message: "Missing guest reservation token.",
      statusCode: 400,
    });
  }

  const now = new Date();
  let modification = await prisma.reservationModification.findFirst({
    where: {
      id: modificationId,
      reservation: {
        guestToken,
        OR: [
          { guestTokenExpiresAt: null },
          { guestTokenExpiresAt: { gt: now } },
        ],
      },
    },
    include: {
      reservation: {
        include: {
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

  if (!modification) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_MODIFICATION_NOT_FOUND",
      message: "Reservation modification not found or guest link has expired.",
      statusCode: 404,
    });
  }

  const additionalChargeAmountCents = toCents(
    modification.additionalChargeAmount,
    "INVALID_ADDITIONAL_CHARGE_AMOUNT"
  );
  const additionalPlatformFeeAmountCents = toCents(
    modification.additionalPlatformFeeAmount,
    "INVALID_ADDITIONAL_PLATFORM_FEE_AMOUNT"
  );
  const additionalHostPayoutAmountCents = toCents(
    modification.additionalHostPayoutAmount,
    "INVALID_ADDITIONAL_HOST_PAYOUT_AMOUNT"
  );

  if (
    modification.financialAction !==
      ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED ||
    additionalChargeAmountCents <= 0 ||
    additionalPlatformFeeAmountCents + additionalHostPayoutAmountCents !==
      additionalChargeAmountCents
  ) {
    throw new GuestReservationModificationError({
      code: "INVALID_RESERVATION_MODIFICATION_FINANCIAL_SPLIT",
      message: "This modification does not have a valid additional payment split.",
      statusCode: 409,
    });
  }

  if (modification.stripeCheckoutSessionId) {
    const existingSession = await stripe.checkout.sessions.retrieve(
      modification.stripeCheckoutSessionId
    );

    if (
      existingSession.metadata?.reservationModificationId !== modification.id
    ) {
      throw new GuestReservationModificationError({
        code: "STRIPE_CHECKOUT_MODIFICATION_MISMATCH",
        message: "The existing Stripe Checkout does not match this modification.",
        statusCode: 409,
      });
    }

    if (existingSession.status === "expired") {
      await prisma.reservationModification.updateMany({
        where: {
          id: modification.id,
          status: ReservationModificationStatus.AWAITING_PAYMENT,
        },
        data: {
          status: ReservationModificationStatus.EXPIRED,
          expiredAt: now,
          stripePaymentStatus: existingSession.payment_status,
        },
      });
    }

    return serializeCheckoutResult({
      modificationId: modification.id,
      status:
        existingSession.status === "expired"
          ? ReservationModificationStatus.EXPIRED
          : modification.status,
      session: existingSession,
      additionalChargeAmountCents,
      currency: modification.currency,
      idempotentReplay: true,
    });
  }

  if (
    modification.status !== ReservationModificationStatus.AWAITING_PAYMENT
  ) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_MODIFICATION_NOT_AWAITING_PAYMENT",
      message: "This reservation modification is not awaiting payment.",
      statusCode: 409,
      details: {
        status: modification.status,
      },
    });
  }

  if (
    !modification.checkoutExpiresAt ||
    modification.checkoutExpiresAt.getTime() <=
      now.getTime() + 30 * 60 * 1000
  ) {
    await prisma.reservationModification.updateMany({
      where: {
        id: modification.id,
        status: ReservationModificationStatus.AWAITING_PAYMENT,
        stripeCheckoutSessionId: null,
      },
      data: {
        status: ReservationModificationStatus.EXPIRED,
        expiredAt: now,
      },
    });

    throw new GuestReservationModificationError({
      code: "RESERVATION_MODIFICATION_CHECKOUT_WINDOW_EXPIRED",
      message: "The payment window expired. Please preview the modification again.",
      statusCode: 409,
    });
  }

  const reservation = modification.reservation;
  const guestEmail = normalize(reservation.guestEmail);

  if (
    reservation.status !== ReservationStatus.ACTIVE ||
    reservation.paymentState !== PaymentState.PAID ||
    reservation.checkIn <= now ||
    reservation.updatedAt.getTime() !==
      modification.baseReservationUpdatedAt.getTime()
  ) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_CHANGED_RETRY_PREVIEW",
      message: "The reservation changed before payment Checkout was created.",
      statusCode: 409,
    });
  }

  if (!/^\S+@\S+\.\S+$/.test(guestEmail)) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_GUEST_EMAIL_REQUIRED_FOR_CHECKOUT",
      message: "A valid guest email is required to create payment Checkout.",
      statusCode: 409,
    });
  }

  const availability = await checkPropertyAvailability({
    propertyId: reservation.propertyId,
    checkIn: modification.proposedCheckIn,
    checkOut: modification.proposedCheckOut,
    excludeReservationId: reservation.id,
    excludeReservationModificationId: modification.id,
  });

  if (!availability.available) {
    throw new GuestReservationModificationError({
      code: "PROPERTY_NOT_AVAILABLE_FOR_SELECTED_DATES",
      message: "The property is no longer available for the selected dates.",
      statusCode: 409,
      details: {
        conflictType: availability.conflict?.type ?? null,
      },
    });
  }

  const currentProposedPricing = await calculateDirectBookingPricing({
    propertyId: reservation.propertyId,
    checkIn: modification.proposedCheckIn,
    checkOut: modification.proposedCheckOut,
    selectedAmenityIds: modification.proposedSelectedAmenityIds,
    excludeReservationId: reservation.id,
  });
  const storedProposedTotalAmountCents = toCents(
    modification.proposedTotalAmount,
    "INVALID_PROPOSED_TOTAL_AMOUNT"
  );

  if (
    currentProposedPricing.totalAmountCents !==
    storedProposedTotalAmountCents
  ) {
    await prisma.reservationModification.updateMany({
      where: {
        id: modification.id,
        status: ReservationModificationStatus.AWAITING_PAYMENT,
        stripeCheckoutSessionId: null,
      },
      data: {
        status: ReservationModificationStatus.EXPIRED,
        expiredAt: now,
        failureCode: "RESERVATION_MODIFICATION_PRICE_CHANGED",
        failureMessage:
          "The proposed reservation price changed before Checkout was created.",
        failureDetails: {
          storedProposedTotalAmountCents,
          currentProposedTotalAmountCents:
            currentProposedPricing.totalAmountCents,
        },
      },
    });

    throw new GuestReservationModificationError({
      code: "RESERVATION_MODIFICATION_PRICE_CHANGED",
      message: "The price changed. Please review the reservation modification again.",
      statusCode: 409,
    });
  }

  const payoutReady = await assertDirectBookingPayoutReady(
    reservation.property.organizationId
  );
  const destinationSnapshot =
    modification.stripeConnectedAccountId ?? payoutReady.connectedAccountId;

  if (
    modification.stripeConnectedAccountId &&
    modification.stripeConnectedAccountId !== payoutReady.connectedAccountId
  ) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_MODIFICATION_CONNECT_DESTINATION_CHANGED",
      message: "The host payout destination changed. Please start the modification again.",
      statusCode: 409,
    });
  }

  await prisma.reservationModification.updateMany({
    where: {
      id: modification.id,
      status: ReservationModificationStatus.AWAITING_PAYMENT,
      stripeCheckoutSessionId: null,
      OR: [
        { stripeConnectedAccountId: null },
        { stripeConnectedAccountId: destinationSnapshot },
      ],
    },
    data: {
      stripeConnectedAccountId: destinationSnapshot,
      failureCode: null,
      failureMessage: null,
      failureDetails: undefined,
    },
  });

  modification = await prisma.reservationModification.findUniqueOrThrow({
    where: { id: modification.id },
    include: {
      reservation: {
        include: {
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

  if (modification.stripeConnectedAccountId !== destinationSnapshot) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_MODIFICATION_CONNECT_DESTINATION_CONFLICT",
      message: "The host payout destination could not be reserved safely.",
      statusCode: 409,
    });
  }

  const manageReservationUrl = `${getAppUrl()}/booking/manage/${encodeURIComponent(
    guestToken
  )}`;
  const checkoutContract =
    buildGuestReservationModificationCheckoutSessionParams({
      modificationId: modification.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      propertyName: reservation.property.name,
      guestEmail,
      preferredLanguage: reservation.preferredLanguage,
      connectedAccountId: destinationSnapshot,
      additionalChargeAmountCents,
      additionalPlatformFeeAmountCents,
      additionalHostPayoutAmountCents,
      currency: modification.currency.toLowerCase(),
      expiresAt: modification.checkoutExpiresAt!,
      manageReservationUrl,
    });

  let session: Stripe.Checkout.Session;

  try {
    session = await stripe.checkout.sessions.create(
      checkoutContract.params,
      {
        idempotencyKey: checkoutContract.idempotencyKey,
      }
    );
  } catch (error: any) {
    await prisma.reservationModification
      .update({
        where: { id: modification.id },
        data: {
          failureCode: "STRIPE_CHECKOUT_CREATION_FAILED",
          failureMessage:
            error?.message ?? "Stripe Checkout creation failed.",
          failureDetails: {
            type: error?.type ?? null,
            code: error?.code ?? null,
          },
        },
      })
      .catch(() => {});

    throw new GuestReservationModificationError({
      code: "STRIPE_CHECKOUT_CREATION_FAILED",
      message: error?.message ?? "Stripe Checkout creation failed.",
      statusCode: error?.statusCode ?? 502,
    });
  }

  const persisted = await prisma.reservationModification.updateMany({
    where: {
      id: modification.id,
      status: ReservationModificationStatus.AWAITING_PAYMENT,
      OR: [
        { stripeCheckoutSessionId: null },
        { stripeCheckoutSessionId: session.id },
      ],
    },
    data: {
      stripeCheckoutSessionId: session.id,
      stripePaymentStatus: session.payment_status,
      checkoutExpiresAt: new Date(session.expires_at * 1000),
      failureCode: null,
      failureMessage: null,
    },
  });

  if (persisted.count === 0) {
    const current = await prisma.reservationModification.findUnique({
      where: { id: modification.id },
      select: {
        stripeCheckoutSessionId: true,
      },
    });

    if (current?.stripeCheckoutSessionId !== session.id) {
      throw new GuestReservationModificationError({
        code: "STRIPE_CHECKOUT_PERSISTENCE_CONFLICT",
        message: "Stripe Checkout could not be attached to this modification safely.",
        statusCode: 409,
      });
    }
  }

  return serializeCheckoutResult({
    modificationId: modification.id,
    status: ReservationModificationStatus.AWAITING_PAYMENT,
    session,
    additionalChargeAmountCents,
    currency: modification.currency,
    idempotentReplay: false,
  });
}
