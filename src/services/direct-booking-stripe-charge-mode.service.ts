import type Stripe from "stripe";

export type DirectBookingStripeChargeMode =
  | "DESTINATION_CHARGE"
  | "DIRECT_CHARGE";

const DIRECT_CHARGES_ENV =
  "DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED";

export function directBookingDirectChargesEnabled(
  env: NodeJS.ProcessEnv = process.env
) {
  return String(env[DIRECT_CHARGES_ENV] ?? "")
    .trim()
    .toLowerCase() === "true";
}

export function resolveDirectBookingStripeChargeMode(
  env: NodeJS.ProcessEnv = process.env
): DirectBookingStripeChargeMode {
  return directBookingDirectChargesEnabled(env)
    ? "DIRECT_CHARGE"
    : "DESTINATION_CHARGE";
}

function requireConnectedAccountId(value: unknown) {
  const connectedAccountId = String(value ?? "").trim();

  if (!connectedAccountId.startsWith("acct_")) {
    throw new Error("DIRECT_BOOKING_STRIPE_CONNECTED_ACCOUNT_INVALID");
  }

  return connectedAccountId;
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
  const chargeMode = resolveDirectBookingStripeChargeMode(input.env);

  if (chargeMode === "DESTINATION_CHARGE") {
    return {
      chargeMode,
      paymentIntentData: {
        ...input.paymentIntentData,
        transfer_data: {
          destination: connectedAccountId,
        },
      } satisfies Stripe.Checkout.SessionCreateParams.PaymentIntentData,
      requestOptions: undefined as Stripe.RequestOptions | undefined,
    };
  }

  const {
    transfer_data: _legacyTransferData,
    ...directPaymentIntentData
  } = input.paymentIntentData;

  return {
    chargeMode,
    paymentIntentData:
      directPaymentIntentData satisfies Stripe.Checkout.SessionCreateParams.PaymentIntentData,
    requestOptions: {
      stripeAccount: connectedAccountId,
    } satisfies Stripe.RequestOptions,
  };
}

export function buildDirectBookingStripeObjectRequestOptions(input: {
  connectedAccountId: string;
  chargeMode: DirectBookingStripeChargeMode;
}) {
  if (input.chargeMode !== "DIRECT_CHARGE") {
    return undefined;
  }

  return {
    stripeAccount: requireConnectedAccountId(input.connectedAccountId),
  } satisfies Stripe.RequestOptions;
}

export function buildDirectBookingRefundStripeContext(input: {
  connectedAccountId: string;
  chargeMode: DirectBookingStripeChargeMode;
  refundApplicationFee: boolean;
}) {
  if (input.chargeMode === "DESTINATION_CHARGE") {
    return {
      params: {
        reverse_transfer: true,
        refund_application_fee: input.refundApplicationFee,
      } satisfies Pick<
        Stripe.RefundCreateParams,
        "reverse_transfer" | "refund_application_fee"
      >,
      requestOptions: undefined as Stripe.RequestOptions | undefined,
    };
  }

  return {
    params: {
      refund_application_fee: input.refundApplicationFee,
    } satisfies Pick<
      Stripe.RefundCreateParams,
      "reverse_transfer" | "refund_application_fee"
    >,
    requestOptions: {
      stripeAccount: requireConnectedAccountId(input.connectedAccountId),
    } satisfies Stripe.RequestOptions,
  };
}

export function resolveDirectBookingChargeModeFromMetadata(
  metadata: Record<string, string> | null | undefined
): DirectBookingStripeChargeMode {
  return metadata?.stripeChargeMode === "DIRECT_CHARGE"
    ? "DIRECT_CHARGE"
    : "DESTINATION_CHARGE";
}

export function directBookingStripeChargeModeMetadata(
  chargeMode: DirectBookingStripeChargeMode
) {
  return {
    stripeChargeMode: chargeMode,
  };
}
