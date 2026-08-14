import assert from "node:assert/strict";
import test from "node:test";

process.env.STRIPE_SECRET_KEY ??= "sk_test_contract_only";

const { buildGuestReservationModificationCheckoutSessionParams } =
  await import("./guest-reservation-modification-checkout.service");

const common = {
  modificationId: "modification_001",
  reservationId: "reservation_001",
  propertyId: "property_001",
  propertyName: "Casa Collores",
  guestEmail: "guest@example.com",
  preferredLanguage: "es",
  connectedAccountId: "acct_connected_001",
  additionalChargeAmountCents: 10_000,
  additionalPlatformFeeAmountCents: 500,
  additionalHostPayoutAmountCents: 9_500,
  currency: "usd",
  expiresAt: new Date("2026-10-10T20:00:00.000Z"),
  manageReservationUrl:
    "https://app.pin-ngo.com/booking/manage/guest_token_001",
};

test("builds a destination charge Checkout for the exact additional amount", () => {
  const result = buildGuestReservationModificationCheckoutSessionParams(
    common
  );
  const paymentIntentData = result.params.payment_intent_data;
  const priceData = result.params.line_items?.[0]?.price_data;

  assert.equal(result.params.mode, "payment");
  assert.equal(result.params.customer_email, common.guestEmail);
  assert.equal(result.params.client_reference_id, common.modificationId);
  assert.equal(priceData?.unit_amount, common.additionalChargeAmountCents);
  assert.equal(priceData?.currency, "usd");
  assert.equal(
    paymentIntentData?.transfer_data?.destination,
    common.connectedAccountId
  );
  assert.equal(
    paymentIntentData?.application_fee_amount,
    common.additionalPlatformFeeAmountCents
  );
});

test("uses modification identity consistently in metadata and idempotency", () => {
  const result = buildGuestReservationModificationCheckoutSessionParams(
    common
  );

  assert.equal(
    result.idempotencyKey,
    `direct-booking-reservation-modification-checkout:${common.modificationId}`
  );
  assert.equal(
    result.params.metadata?.flow,
    "direct_booking_reservation_modification"
  );
  assert.equal(
    result.params.metadata?.reservationModificationId,
    common.modificationId
  );
  assert.equal(
    result.params.payment_intent_data?.metadata
      ?.reservationModificationId,
    common.modificationId
  );
  assert.equal(
    result.params.metadata?.additionalHostPayoutAmountCents,
    "9500"
  );
});

test("preserves the approved expiration and returns to the guest portal", () => {
  const result = buildGuestReservationModificationCheckoutSessionParams(
    common
  );
  const successUrl = new URL(String(result.params.success_url));
  const cancelUrl = new URL(String(result.params.cancel_url));

  assert.equal(
    result.params.expires_at,
    Math.floor(common.expiresAt.getTime() / 1000)
  );
  assert.equal(successUrl.origin, "https://app.pin-ngo.com");
  assert.equal(successUrl.pathname, "/booking/manage/guest_token_001");
  assert.equal(successUrl.searchParams.get("modificationPayment"), "success");
  assert.equal(
    successUrl.searchParams.get("modificationId"),
    common.modificationId
  );
  assert.equal(cancelUrl.searchParams.get("modificationPayment"), "cancelled");
  assert.equal(
    cancelUrl.searchParams.get("modificationId"),
    common.modificationId
  );
});

test("omits application fee when the incremental Pin&Go fee is zero", () => {
  const result = buildGuestReservationModificationCheckoutSessionParams({
    ...common,
    additionalPlatformFeeAmountCents: 0,
    additionalHostPayoutAmountCents: 10_000,
  });

  assert.equal(
    result.params.payment_intent_data?.application_fee_amount,
    undefined
  );
  assert.equal(
    result.params.payment_intent_data?.transfer_data?.destination,
    common.connectedAccountId
  );
});

test("renders the Checkout item in the guest preferred language", () => {
  const spanish = buildGuestReservationModificationCheckoutSessionParams(
    common
  );
  const english = buildGuestReservationModificationCheckoutSessionParams({
    ...common,
    preferredLanguage: "en",
  });

  assert.equal(spanish.params.locale, "es");
  assert.match(
    String(spanish.params.line_items?.[0]?.price_data?.product_data?.name),
    /Modificación de reserva/
  );
  assert.equal(english.params.locale, "en");
  assert.match(
    String(english.params.line_items?.[0]?.price_data?.product_data?.name),
    /Reservation modification/
  );
});
