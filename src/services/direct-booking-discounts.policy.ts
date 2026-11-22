import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid date");
const optionalDate = date.nullable();
const percent = z.number().finite().min(0).max(100);
const rule = z.object({
  id: z.string().min(1).max(80),
  enabled: z.boolean(),
  type: z.enum(["EARLY_BIRD", "LENGTH_OF_STAY"]),
  threshold: z.number().int().min(1).max(3650),
  percent: percent.refine(value => value > 0, "Discount must be greater than zero"),
  bookingFrom: optionalDate, bookingTo: optionalDate,
  stayFrom: optionalDate, stayTo: optionalDate,
  excludedDates: z.array(date).max(730),
}).strict().superRefine((value, ctx) => {
  for (const [from, to] of [[value.bookingFrom, value.bookingTo], [value.stayFrom, value.stayTo]]) {
    if (from && to && from > to) ctx.addIssue({ code: "custom", message: "Start date must precede end date" });
  }
});
export const discountConfigSchema = z.object({
  enabled: z.boolean(),
  combination: z.enum(["BEST", "STACK"]),
  maxDiscountPercent: percent,
  minimumFinalNightlyRate: z.number().finite().min(0).max(1000000),
  rules: z.array(rule).max(50),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.rules.map(r => r.id)).size !== value.rules.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate rule identifiers" });
  }
});
export type DiscountConfig = z.infer<typeof discountConfigSchema>;
export const defaultDiscountConfig: DiscountConfig = {
  enabled: false, combination: "BEST", maxDiscountPercent: 100,
  minimumFinalNightlyRate: 0, rules: [],
};
const cents = (value: number) => Math.round(value * 100);
const dayNumber = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86400000;

// Discounts are a separate subtotal adjustment. Never mutate nightly rates.
export function calculateAccommodationDiscount(input: {
  config: DiscountConfig; subtotal: number; stayDates: string[];
  checkIn: Date; now: Date; timeZone: string;
}) {
  const { config, stayDates } = input;
  const original = cents(input.subtotal);
  if (!Number.isSafeInteger(original) || original < 0 || !stayDates.length) throw new Error("INVALID_DISCOUNT_STAY");
  const bookingDate = formatInTimeZone(input.now, input.timeZone, "yyyy-MM-dd");
  const arrivalDate = formatInTimeZone(input.checkIn, input.timeZone, "yyyy-MM-dd");
  const leadDays = dayNumber(arrivalDate) - dayNumber(bookingDate);
  const eligible = config.enabled ? config.rules.filter(r =>
    r.enabled && (r.type === "EARLY_BIRD" ? leadDays : stayDates.length) >= r.threshold &&
    (!r.bookingFrom || bookingDate >= r.bookingFrom) && (!r.bookingTo || bookingDate <= r.bookingTo) &&
    stayDates.every(d => (!r.stayFrom || d >= r.stayFrom) && (!r.stayTo || d <= r.stayTo) && !r.excludedDates.includes(d))
  ) : [];
  // Highest qualifying threshold wins within each type, even for non-monotonic percentages.
  const levels = (["EARLY_BIRD", "LENGTH_OF_STAY"] as const).flatMap(type => {
    const matches = eligible.filter(r => r.type === type).sort((a, b) => b.threshold - a.threshold || b.percent - a.percent || a.id.localeCompare(b.id));
    return matches.length ? [matches[0]!] : [];
  });
  const selected = config.combination === "STACK" ? levels : levels.sort((a, b) => b.percent - a.percent).slice(0, 1);
  const floor = Math.min(original, cents(config.minimumFinalNightlyRate) * stayDates.length);
  const maximum = Math.min(Math.floor(original * config.maxDiscountPercent / 100), original - floor);
  let remaining = original;
  let used = 0;
  const discounts = selected.flatMap(r => {
    const amount = Math.max(0, Math.min(Math.round(remaining * r.percent / 100), maximum - used));
    remaining -= amount; used += amount;
    return amount ? [{ ruleId: r.id, type: r.type, threshold: r.threshold, percent: r.percent, amount: amount / 100 }] : [];
  });
  return { accommodationSubtotalBeforeDiscount: original / 100, accommodationDiscountTotal: used / 100,
    accommodationSubtotalAfterDiscount: remaining / 100, discounts };
}

export function applyAccommodationDiscountToQuote<T extends {
  nightlySubtotal: number; cleaningFee: number; amenitiesTotal: number;
  taxes: Array<{ id: string; name: string; percentage: number; amount: number }>;
}>(pricing: T, discount: ReturnType<typeof calculateAccommodationDiscount>) {
  const money = (v: number) => Math.round(v * 100) / 100;
  const taxableSubtotal = money(discount.accommodationSubtotalAfterDiscount + pricing.cleaningFee + pricing.amenitiesTotal);
  const taxes = pricing.taxes.map(t => ({ ...t, amount: money(taxableSubtotal * t.percentage / 100) }));
  const taxesTotal = money(taxes.reduce((sum, t) => sum + t.amount, 0));
  const totalAmount = money(taxableSubtotal + taxesTotal);
  return { ...pricing, ...discount, taxableSubtotal, taxes, taxesTotal, totalAmount,
    totalAmountCents: Math.round(totalAmount * 100) };
}
