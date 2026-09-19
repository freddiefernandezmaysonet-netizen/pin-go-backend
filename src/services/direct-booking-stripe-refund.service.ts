import type Stripe from "stripe";
import { buildDirectBookingRefundStripeContext } from "./direct-booking-stripe-charge-mode.service.js";

type RefundClient = {
  refunds: {
    create: (
      params: Stripe.RefundCreateParams,
      options?: Stripe.RequestOptions
    ) => Promise<Stripe.Refund>;
  };
};

export async function createDirectBookingStripeRefund(input: {
  stripeClient: RefundClient;
  params: Stripe.RefundCreateParams;
  options?: Stripe.RequestOptions;
  connectedAccountId?: string | null;
}) {
  const refundStripeContext = buildDirectBookingRefundStripeContext({
    connectedAccountId: String(input.connectedAccountId ?? "").trim(),
    chargeMode: "DIRECT_CHARGE",
    refundApplicationFee: Boolean(input.params.refund_application_fee),
  });

  const directOptions: Stripe.RequestOptions = {
    ...(input.options ?? {}),
    ...(refundStripeContext.requestOptions ?? {}),
  };

  const refund = await input.stripeClient.refunds.create(
    input.params,
    directOptions
  );

  return {
    refund,
    chargeMode: "DIRECT_CHARGE" as const,
    reverseTransfer: false,
    stripeAccount: directOptions.stripeAccount ?? null,
  };
}
