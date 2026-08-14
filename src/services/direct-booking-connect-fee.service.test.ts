import assert from "node:assert/strict";
import test from "node:test";
import { calculateDirectBookingModificationConnectFee } from "./direct-booking-connect-fee.service";

test("splits an additional charge using only the incremental percentage", () => {
  const result = calculateDirectBookingModificationConnectFee({
    additionalChargeAmountCents: 10_000,
    platformFeePercent: 5,
  });

  assert.deepEqual(result, {
    additionalChargeAmountCents: 10_000,
    platformFeePercent: 5,
    additionalPlatformFeeAmountCents: 500,
    additionalHostPayoutAmountCents: 9_500,
    identityCheckFeeAmountCents: 0,
  });
});

test("routes the entire additional charge to the host when the fee is zero", () => {
  const result = calculateDirectBookingModificationConnectFee({
    additionalChargeAmountCents: 7_500,
    platformFeePercent: 0,
  });

  assert.equal(result.additionalPlatformFeeAmountCents, 0);
  assert.equal(result.additionalHostPayoutAmountCents, 7_500);
  assert.equal(result.identityCheckFeeAmountCents, 0);
});

test("rounds the incremental platform fee to the nearest cent", () => {
  const result = calculateDirectBookingModificationConnectFee({
    additionalChargeAmountCents: 999,
    platformFeePercent: 2.9,
  });

  assert.equal(result.additionalPlatformFeeAmountCents, 29);
  assert.equal(result.additionalHostPayoutAmountCents, 970);
});

test("never allocates more than the additional charge to the platform", () => {
  const result = calculateDirectBookingModificationConnectFee({
    additionalChargeAmountCents: 1_000,
    platformFeePercent: 150,
  });

  assert.equal(result.additionalPlatformFeeAmountCents, 1_000);
  assert.equal(result.additionalHostPayoutAmountCents, 0);
});

test("rejects zero or invalid additional charge amounts", () => {
  for (const additionalChargeAmountCents of [0, -1, Number.NaN]) {
    assert.throws(
      () =>
        calculateDirectBookingModificationConnectFee({
          additionalChargeAmountCents,
          platformFeePercent: 5,
        }),
      /DIRECT_BOOKING_MODIFICATION_CHARGE_AMOUNT_INVALID/
    );
  }
});

test("rejects invalid platform fee percentages", () => {
  for (const platformFeePercent of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        calculateDirectBookingModificationConnectFee({
          additionalChargeAmountCents: 10_000,
          platformFeePercent,
        }),
      /DIRECT_BOOKING_MODIFICATION_PLATFORM_FEE_PERCENT_INVALID/
    );
  }
});
