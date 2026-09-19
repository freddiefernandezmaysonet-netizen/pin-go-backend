import type Stripe from "stripe";
import type { DirectBookingStripeChargeMode } from "./direct-booking-stripe-charge-mode.service.js";

type CheckoutSessionReader = {
  checkout: {
    sessions: {
      retrieve: (
        id: string,
        options?: Stripe.RequestOptions
      ) => Promise<Stripe.Checkout.Session>;
    };
  };
};

type PaymentIntentReader = {
  paymentIntents: {
    retrieve: (
      id: string,
      params?: Stripe.PaymentIntentRetrieveParams,
      options?: Stripe.RequestOptions
    ) => Promise<Stripe.PaymentIntent>;
  };
};

function requireConnectedAccountId(value: unknown) {
  const accountId = String(value ?? "").trim();

  if (!accountId.startsWith("acct_")) {
    throw new Error("DIRECT_BOOKING_STRIPE_CONNECTED_ACCOUNT_INVALID");
  }

  return accountId;
}

export async function retrieveDirectBookingCheckoutSession(input: {
  stripeClient: CheckoutSessionReader;
  sessionId: string;
  connectedAccountId?: string | null;
}) {
  const connectedAccountId = requireConnectedAccountId(
    input.connectedAccountId
  );
  const session = await input.stripeClient.checkout.sessions.retrieve(
    input.sessionId,
    { stripeAccount: connectedAccountId }
  );

  return {
    session,
    chargeMode: "DIRECT_CHARGE" as DirectBookingStripeChargeMode,
    stripeAccount: connectedAccountId,
  };
}

export async function retrieveDirectBookingPaymentIntent(input: {
  stripeClient: PaymentIntentReader;
  paymentIntentId: string;
  connectedAccountId?: string | null;
  params?: Stripe.PaymentIntentRetrieveParams;
}) {
  const connectedAccountId = requireConnectedAccountId(
    input.connectedAccountId
  );
  const paymentIntent = await input.stripeClient.paymentIntents.retrieve(
    input.paymentIntentId,
    input.params,
    { stripeAccount: connectedAccountId }
  );

  return {
    paymentIntent,
    chargeMode: "DIRECT_CHARGE" as DirectBookingStripeChargeMode,
    stripeAccount: connectedAccountId,
  };
}
