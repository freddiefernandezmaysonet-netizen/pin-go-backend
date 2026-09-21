import type Stripe from "stripe";

export type DirectBookingStripeChargeMode = "DIRECT_CHARGE";

function requireConnectedAccountId(value: unknown) {
  const connectedAccountId = String(value ?? "").trim();

  if (!connectedAccountId.startsWith("acct_")) {
    throw new Error("DIRECT_BOOKING_STRIPE_CONNECTED_ACCOUNT_INVALID");
  }

  return connectedAccountId;
}

export function resolveDirectBookingStripeChargeMode(
  _env: NodeJS.ProcessEnv = process.env,
  connectedAccountId?: string | null
): DirectBookingStripeChargeMode {
  requireConnectedAccountId(connectedAccountId);
  return "DIRECT_CHARGE";
}

export function buildDirectBookingCheckoutStripeContext(input: {
  connectedAccountId: string;
  paymentIntentData:
    Stripe.Checkout.SessionCreateParams.PaymentIntentData;
  env?: NodeJS.ProcessEnv;
}) {
  const connectedAccountId = requireConnectedAccountId(
    input.connectedAccountId
  );

  return {
    chargeMode: "DIRECT_CHARGE" as const,
    paymentIntentData:
      input.paymentIntentData satisfies Stripe.Checkout.SessionCreateParams.PaymentIntentData,
    requestOptions: {
      stripeAccount: connectedAccountId,
    } satisfies Stripe.RequestOptions,
  };
}

export function buildDirectBookingStripeObjectRequestOptions(input: {
  connectedAccountId: string;
  chargeMode: DirectBookingStripeChargeMode;
}) {
  return {
    stripeAccount: requireConnectedAccountId(input.connectedAccountId),
  } satisfies Stripe.RequestOptions;
}

export function buildDirectBookingRefundStripeContext(input: {
  connectedAccountId: string;
  chargeMode: DirectBookingStripeChargeMode;
  refundApplicationFee: boolean;
}) {
  return {
    params: {
      refund_application_fee: input.refundApplicationFee,
    } satisfies Pick<
      Stripe.RefundCreateParams,
      "refund_application_fee"
    >,
    requestOptions: {
      stripeAccount: requireConnectedAccountId(input.connectedAccountId),
    } satisfies Stripe.RequestOptions,
  };
}

export function resolveDirectBookingChargeModeFromMetadata(
  metadata: Record<string, string> | null | undefined
): DirectBookingStripeChargeMode {
  if (metadata?.stripeChargeMode !== "DIRECT_CHARGE") {
    throw new Error("DIRECT_BOOKING_STRIPE_CHARGE_MODE_INVALID");
  }

  return "DIRECT_CHARGE";
}

export function directBookingStripeChargeModeMetadata(
  _chargeMode: DirectBookingStripeChargeMode
) {
  return {
    stripeChargeMode: "DIRECT_CHARGE",
  };
}
