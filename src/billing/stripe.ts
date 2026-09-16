import Stripe from "stripe";
import {
  buildDirectBookingCheckoutStripeContext,
  directBookingDirectChargesEnabled,
} from "../services/direct-booking-stripe-charge-mode.service.js";

const raw = process.env.STRIPE_SECRET_KEY;

if (!raw) {
  throw new Error("Missing STRIPE_SECRET_KEY in .env");
}

const key = raw.trim();

console.log("STRIPE KEY CHECK:", {
  prefix: key.slice(0, 10),  // sk_test_...
  len: key.length,
  hasStars: key.includes("*"),
  hasSpace: /\s/.test(raw),
});

const stripe = new Stripe(key, {
  apiVersion: "2023-10-16",
});

const originalCheckoutSessionCreate =
  stripe.checkout.sessions.create.bind(stripe.checkout.sessions);

stripe.checkout.sessions.create = (async (
  params: Stripe.Checkout.SessionCreateParams,
  options?: Stripe.RequestOptions
) => {
  const flow = String(params.metadata?.flow ?? "").trim();
  const isDirectBookingFlow =
    flow === "direct_booking" ||
    flow === "direct_booking_reservation_modification";

  if (!isDirectBookingFlow || !directBookingDirectChargesEnabled()) {
    return originalCheckoutSessionCreate(params, options);
  }

  const connectedAccountId = String(
    params.metadata?.stripeConnectedAccountId ??
      params.metadata?.connectedAccountId ??
      ""
  ).trim();

  const checkoutContext = buildDirectBookingCheckoutStripeContext({
    connectedAccountId,
    paymentIntentData: params.payment_intent_data ?? {},
  });

  const nextParams: Stripe.Checkout.SessionCreateParams = {
    ...params,
    payment_intent_data: {
      ...checkoutContext.paymentIntentData,
      metadata: {
        ...(checkoutContext.paymentIntentData.metadata ?? {}),
        stripeChargeMode: checkoutContext.chargeMode,
      },
    },
    metadata: {
      ...(params.metadata ?? {}),
      stripeChargeMode: checkoutContext.chargeMode,
    },
  };

  const nextOptions: Stripe.RequestOptions = {
    ...(options ?? {}),
    ...(checkoutContext.requestOptions ?? {}),
  };

  return originalCheckoutSessionCreate(nextParams, nextOptions);
}) as typeof stripe.checkout.sessions.create;

const originalConstructEvent =
  stripe.webhooks.constructEvent.bind(stripe.webhooks);

stripe.webhooks.constructEvent = ((...args: any[]) => {
  try {
    return (originalConstructEvent as any)(...args);
  } catch (primaryError) {
    const connectWebhookSecret = String(
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? ""
    ).trim();

    if (
      !directBookingDirectChargesEnabled() ||
      !connectWebhookSecret ||
      connectWebhookSecret === String(args[2] ?? "")
    ) {
      throw primaryError;
    }

    const connectArgs = [...args];
    connectArgs[2] = connectWebhookSecret;

    return (originalConstructEvent as any)(...connectArgs);
  }
}) as typeof stripe.webhooks.constructEvent;

export default stripe;
