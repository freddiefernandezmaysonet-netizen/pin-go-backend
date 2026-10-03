import type Stripe from "stripe";

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
    metadata: {
      flow: "direct_booking_reservation_modification",
      stripeChargeMode: "DIRECT_CHARGE",
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
      stripeChargeMode: "DIRECT_CHARGE",
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
    requestOptions: {
      stripeAccount: input.connectedAccountId,
    } satisfies Stripe.RequestOptions,
    idempotencyKey: `direct-booking-reservation-modification-checkout:${input.modificationId}`,
  };
}
