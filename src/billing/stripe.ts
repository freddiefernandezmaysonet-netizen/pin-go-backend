import Stripe from "stripe";
import {
  buildDirectBookingCheckoutStripeContext,
  directBookingDirectChargesAllowedForConnectedAccount,
  directBookingDirectChargesEnabled,
} from "../services/direct-booking-stripe-charge-mode.service.js";

const raw = process.env.STRIPE_SECRET_KEY;

if (!raw) {
  throw new Error("Missing STRIPE_SECRET_KEY in .env");
}

const key = raw.trim();


const stripe = new Stripe(key, {
  apiVersion: "2023-10-16",
});

const CONNECT_CANARY_IGNORED_EVENT_TYPE =
  "pin_go.connect_canary_ignored";

const originalCheckoutSessionCreate =
  stripe.checkout.sessions.create.bind(stripe.checkout.sessions);

stripe.checkout.sessions.create = (async (
  params: Stripe.Checkout.SessionCreateParams,
  options?: Stripe.RequestOptions
) => {
  const flow = String(params.metadata?.flow ?? "").trim();

  // Direct Charges V1 is intentionally fenced to the initial Direct Booking
  // checkout. Reservation modifications remain on the certified legacy path
  // until their retrieve/payment/refund lifecycle is explicitly migrated.
  if (
    flow !== "direct_booking" ||
    !directBookingDirectChargesEnabled()
  ) {
    return originalCheckoutSessionCreate(params, options);
  }

  const connectedAccountId = String(
    params.metadata?.stripeConnectedAccountId ?? ""
  ).trim();

  const checkoutContext = buildDirectBookingCheckoutStripeContext({
    connectedAccountId,
    paymentIntentData: params.payment_intent_data ?? {},
  });

  // Initial Direct Booking already uses Stripe's 50-key Session metadata
  // budget. hostPayoutStatus is derivable from stripeConnectedAccountId during
  // ingest, so omit that redundant key before persisting stripeChargeMode.
  const {
    hostPayoutStatus: _derivedHostPayoutStatus,
    ...checkoutSessionMetadata
  } = params.metadata ?? {};

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
      ...checkoutSessionMetadata,
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

    const connectEvent = (originalConstructEvent as any)(
      ...connectArgs
    ) as Stripe.Event;
    const connectedAccountId = String(
      (connectEvent as Stripe.Event & { account?: string }).account ?? ""
    ).trim();

    if (
      !directBookingDirectChargesAllowedForConnectedAccount(
        connectedAccountId
      )
    ) {
      console.warn("[STRIPE_CONNECT_CANARY_EVENT_IGNORED]", {
        eventId: connectEvent.id,
        eventType: connectEvent.type,
        connectedAccountId: connectedAccountId || null,
      });

      return {
        ...connectEvent,
        type: CONNECT_CANARY_IGNORED_EVENT_TYPE,
      } as unknown as Stripe.Event;
    }

    return connectEvent;
  }
}) as typeof stripe.webhooks.constructEvent;

export default stripe;
