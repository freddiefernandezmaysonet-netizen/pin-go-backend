export const PRIME_MIN_NIGHTLY_DISCOUNT = 5;
export const PRIME_MAX_NIGHTLY_DISCOUNT = 20;

export function isPrimeNightlyDiscount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= PRIME_MIN_NIGHTLY_DISCOUNT && value <= PRIME_MAX_NIGHTLY_DISCOUNT;
}
