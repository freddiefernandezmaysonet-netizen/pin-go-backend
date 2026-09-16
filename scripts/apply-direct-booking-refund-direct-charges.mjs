import fs from "node:fs";

const target = "src/services/direct-booking-refund.service.ts";
let source = fs.readFileSync(target, "utf8");

function replaceExactlyOnce(label, before, after) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exact block once`);
  }

  source = source.replace(before, after);
}

replaceExactlyOnce(
  "refund adapter import",
  'import stripe from "../billing/stripe";\n',
  'import stripe from "../billing/stripe";\nimport { createDirectBookingStripeRefund } from "./direct-booking-stripe-refund.service.js";\n'
);

replaceExactlyOnce(
  "Stripe refund call",
  `    const refund = await stripe.refunds.create(\n      {\n        payment_intent: reservation.stripePaymentIntentId,\n        amount: resolvedRefundAmountCents,\n        reverse_transfer: true,\n        refund_application_fee: refundApplicationFee,\n        metadata: {\n          platform: "PinGo",\n          product: "Refunds & Cancellations V1.2",\n          reservationId: reservation.id,\n          propertyId: reservation.propertyId,\n          organizationId,\n          requestedByUserId: requestedByUserId ?? "",\n          requestedByActor,\n          reason: refundReason,\n          refundMode: effectiveRefundMode,\n          refundAmountCents: String(resolvedRefundAmountCents),\n          refundAmount: String(resolvedRefundAmount),\n          refundPercent: String(effectiveRefundPercent),\n        },\n      },\n      {\n        idempotencyKey: refundIdempotencyKey,\n      }\n    );`,
  `    const stripeRefundResult = await createDirectBookingStripeRefund({\n      stripeClient: stripe,\n      connectedAccountId: reservation.stripeConnectedAccountId,\n      params: {\n        payment_intent: reservation.stripePaymentIntentId,\n        amount: resolvedRefundAmountCents,\n        reverse_transfer: true,\n        refund_application_fee: refundApplicationFee,\n        metadata: {\n          platform: "PinGo",\n          product: "Refunds & Cancellations V1.2",\n          reservationId: reservation.id,\n          propertyId: reservation.propertyId,\n          organizationId,\n          requestedByUserId: requestedByUserId ?? "",\n          requestedByActor,\n          reason: refundReason,\n          refundMode: effectiveRefundMode,\n          refundAmountCents: String(resolvedRefundAmountCents),\n          refundAmount: String(resolvedRefundAmount),\n          refundPercent: String(effectiveRefundPercent),\n        },\n      },\n      options: {\n        idempotencyKey: refundIdempotencyKey,\n      },\n    });\n    const refund = stripeRefundResult.refund;`
);

replaceExactlyOnce(
  "refund audit record",
  `      reverseTransfer: true,\n      refundApplicationFee,`,
  `      reverseTransfer: stripeRefundResult.reverseTransfer,\n      stripeChargeMode: stripeRefundResult.chargeMode,\n      stripeAccount: stripeRefundResult.stripeAccount,\n      refundApplicationFee,`
);

fs.writeFileSync(target, source);
