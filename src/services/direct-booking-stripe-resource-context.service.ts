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

function normalizeConnectedAccountId(value: unknown) {
  const accountId = String(value ?? "").trim();
  return accountId.startsWith("acct_") ? accountId : null;
}

export function isStripeResourceMissingError(error: unknown) {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    raw?: { code?: unknown };
  };

  return (
    candidate.code === "resource_missing" ||
    candidate.raw?.code === "resource_missing" ||
    candidate.statusCode === 404
  );
}

export async function retrieveDirectBookingCheckoutSession(input: {
  stripeClient: CheckoutSessionReader;
  sessionId: string;
  connectedAccountId?: string | null;
}) {
  try {
    const session = await input.stripeClient.checkout.sessions.retrieve(
      input.sessionId
    );

    return {
      session,
      chargeMode: "DESTINATION_CHARGE" as DirectBookingStripeChargeMode,
      stripeAccount: null as string | null,
    };
  } catch (error) {
    const connectedAccountId = normalizeConnectedAccountId(
      input.connectedAccountId
    );

    if (!connectedAccountId || !isStripeResourceMissingError(error)) {
      throw error;
    }

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
}

export async function retrieveDirectBookingPaymentIntent(input: {
  stripeClient: PaymentIntentReader;
  paymentIntentId: string;
  connectedAccountId?: string | null;
  params?: Stripe.PaymentIntentRetrieveParams;
}) {
  try {
    const paymentIntent = await input.stripeClient.paymentIntents.retrieve(
      input.paymentIntentId,
      input.params
    );

    return {
      paymentIntent,
      chargeMode: "DESTINATION_CHARGE" as DirectBookingStripeChargeMode,
      stripeAccount: null as string | null,
    };
  } catch (error) {
    const connectedAccountId = normalizeConnectedAccountId(
      input.connectedAccountId
    );

    if (!connectedAccountId || !isStripeResourceMissingError(error)) {
      throw error;
    }

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
}
