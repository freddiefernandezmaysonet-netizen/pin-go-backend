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

function normalizeCents(value: number, errorCode: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(errorCode);
  }

  return Math.round(value);
}
