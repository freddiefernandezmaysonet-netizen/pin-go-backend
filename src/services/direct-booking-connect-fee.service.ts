export function calculateDirectBookingConnectFee(input: {
  totalAmountCents: number;
  basePlatformFeeAmountCents: number;
  identityCheckFeeAmountCents: number;
}) {
  const totalAmountCents = normalizeCents(
    input.totalAmountCents,
    "DIRECT_BOOKING_TOTAL_AMOUNT_INVALID"
  );
  const requestedBaseFeeCents = normalizeCents(
    input.basePlatformFeeAmountCents,
    "DIRECT_BOOKING_BASE_PLATFORM_FEE_INVALID"
  );
  const requestedIdentityFeeCents = normalizeCents(
    input.identityCheckFeeAmountCents,
    "DIRECT_BOOKING_IDENTITY_CHECK_FEE_INVALID"
  );

  if (totalAmountCents <= 0) {
    throw new Error("DIRECT_BOOKING_TOTAL_AMOUNT_INVALID");
  }

  const basePlatformFeeAmountCents = Math.min(
    requestedBaseFeeCents,
    totalAmountCents
  );
  const identityCheckFeeAmountCents = Math.min(
    requestedIdentityFeeCents,
    Math.max(0, totalAmountCents - basePlatformFeeAmountCents)
  );
  const platformFeeAmountCents =
    basePlatformFeeAmountCents + identityCheckFeeAmountCents;

  return {
    totalAmountCents,
    basePlatformFeeAmountCents,
    identityCheckFeeAmountCents,
    platformFeeAmountCents,
    hostPayoutAmountCents: totalAmountCents - platformFeeAmountCents,
  };
}

export function calculateDirectBookingModificationConnectFee(input: {
  additionalChargeAmountCents: number;
  platformFeePercent: number;
}) {
  const additionalChargeAmountCents = normalizeCents(
    input.additionalChargeAmountCents,
    "DIRECT_BOOKING_MODIFICATION_CHARGE_AMOUNT_INVALID"
  );
  const platformFeePercent = normalizePercent(
    input.platformFeePercent,
    "DIRECT_BOOKING_MODIFICATION_PLATFORM_FEE_PERCENT_INVALID"
  );

  if (additionalChargeAmountCents <= 0) {
    throw new Error("DIRECT_BOOKING_MODIFICATION_CHARGE_AMOUNT_INVALID");
  }

  const incrementalBasePlatformFeeAmountCents = Math.round(
    additionalChargeAmountCents * (platformFeePercent / 100)
  );
  const split = calculateDirectBookingConnectFee({
    totalAmountCents: additionalChargeAmountCents,
    basePlatformFeeAmountCents: incrementalBasePlatformFeeAmountCents,
    identityCheckFeeAmountCents: 0,
  });

  return {
    additionalChargeAmountCents,
    platformFeePercent,
    additionalPlatformFeeAmountCents: split.platformFeeAmountCents,
    additionalHostPayoutAmountCents: split.hostPayoutAmountCents,
    identityCheckFeeAmountCents: 0,
  };
}

function normalizeCents(value: number, errorCode: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(errorCode);
  }

  return Math.round(value);
}

function normalizePercent(value: number, errorCode: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(errorCode);
  }

  return value;
}
