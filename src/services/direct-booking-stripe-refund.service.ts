import type Stripe from "stripe";
import { buildDirectBookingRefundStripeContext } from "./direct-booking-stripe-charge-mode.service.js";
import { isStripeResourceMissingError } from "./direct-booking-stripe-resource-context.service.js";

type RefundClient = {
  refunds: {
    create: (
      params: Stripe.RefundCreateParams,
      options?: Stripe.RequestOptions
    ) => Promise<Stripe.Refund>;
  };
};

function normalizeConnectedAccountId(value: unknown) {
  const accountId = String(value ?? "").trim();
  return accountId.startsWith("acct_") ? accountId : null;
}

export async function createDirectBookingStripeRefund(input: {
  stripeClient: RefundClient;
  params: Stripe.RefundCreateParams;
  options?: Stripe.RequestOptions;
  connectedAccountId?: string | null;
}) {
  try {
    const refund = await input.stripeClient.refunds.create(
      input.params,
      input.options
    );

    return {
      refund,
      chargeMode: "DESTINATION_CHARGE" as const,
      reverseTransfer: Boolean(input.params.reverse_transfer),
      stripeAccount: null as string | null,
    };
  } catch (error) {
    const connectedAccountId = normalizeConnectedAccountId(
      input.connectedAccountId
    );

    if (!connectedAccountId || !isStripeResourceMissingError(error)) {
      throw error;
    }

    const refundStripeContext = buildDirectBookingRefundStripeContext({
      connectedAccountId,
      chargeMode: "DIRECT_CHARGE",
      refundApplicationFee: Boolean(input.params.refund_application_fee),
    });

    const {
      reverse_transfer: _legacyReverseTransfer,
      refund_application_fee: _legacyRefundApplicationFee,
      ...baseParams
    } = input.params;

    const directParams: Stripe.RefundCreateParams = {
      ...baseParams,
      ...refundStripeContext.params,
    };
    const directOptions: Stripe.RequestOptions = {
      ...(input.options ?? {}),
      ...(refundStripeContext.requestOptions ?? {}),
    };

    const refund = await input.stripeClient.refunds.create(
      directParams,
      directOptions
    );

    return {
      refund,
      chargeMode: "DIRECT_CHARGE" as const,
      reverseTransfer: false,
      stripeAccount: connectedAccountId,
    };
  }
}
