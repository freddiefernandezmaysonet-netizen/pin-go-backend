export const haasMonthlyAmounts = {
  essential: { 12: 5499, 24: 4499 },
  pro: { 12: 7499, 24: 6499 },
  elite: { 12: 8499, 24: 7499 },
} as const;

export function resolveHaasPrice(selection: any, locks: number, interval: string, env: Record<string, string | undefined> = process.env) {
  if (selection?.termMonths === undefined) return null; // Preserve existing 24-month checkout links.
  const model = selection.lock as keyof typeof haasMonthlyAmounts;
  const term = selection.termMonths;
  if (selection.plan !== 'haas' || !Object.hasOwn(haasMonthlyAmounts, model) || (term !== 12 && term !== 24)
    || locks !== 1 || interval !== 'monthly' || !['none', undefined, ''].includes(selection.smartDevices)) {
    throw new Error('INVALID_HAAS_SELECTION');
  }
  const priceId = env[`STRIPE_PRICE_HAAS_${model.toUpperCase()}_${term}_MONTHLY`]?.trim();
  if (!priceId) throw new Error('HAAS_PRICE_NOT_CONFIGURED');
  return { priceId, amount: haasMonthlyAmounts[model][term as 12 | 24], termMonths: term as 12 | 24,
    selection: { plan: 'haas', lock: model, termMonths: term, smartDevices: 'none' } };
}

export function assertMonthlyPrice(price: any, amount: number, interval: 'month' | 'year' = 'month') {
  if (!price?.active || price.currency !== 'usd' || price.unit_amount !== amount || price.type !== 'recurring'
    || price.tax_behavior !== 'exclusive' || price.billing_scheme !== 'per_unit' || price.transform_quantity
    || price.recurring?.interval !== interval || price.recurring.interval_count !== 1
    || price.recurring.usage_type !== 'licensed') throw new Error('SUBSCRIPTION_PRICE_MISMATCH');
}

export function haasPriceIds(env: Record<string, string | undefined> = process.env) {
  return Object.keys(haasMonthlyAmounts).flatMap(model => [12,24].map(term => env[`STRIPE_PRICE_HAAS_${model.toUpperCase()}_${term}_MONTHLY`]))
    .filter((id): id is string => Boolean(id?.trim())).map(id => id.trim());
}
