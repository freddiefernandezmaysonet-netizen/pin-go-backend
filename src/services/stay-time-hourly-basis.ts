import { formatInTimeZone } from "date-fns-tz";
import { StayTimePolicyError, type StayTimeHourlyBasis, type StayTimeOperation } from "../pin-ai/actions/stay-time-policy.js";

export function deriveStayTimeHourlyBasis(input: {
  operation: StayTimeOperation; checkIn: Date; checkOut: Date; timezone: string;
  standardCheckIn: string; standardCheckOut: string; pricingBreakdown: unknown;
}): StayTimeHourlyBasis {
  const invalid = (): never => { throw new StayTimePolicyError("NIGHTLY_PRICING_BASIS_REQUIRED"); };
  const minutes = (time: string) => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return invalid();
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  };
  // Nominal local overnight duration, independent of DST: 15→11 = 20h;
  // 16→11 = 19h. Additional service time is still measured in elapsed minutes.
  const standardStayMinutes = 1440 - minutes(input.standardCheckIn) + minutes(input.standardCheckOut);
  if (standardStayMinutes <= 0 || standardStayMinutes > 1440) invalid();
  const firstDate = formatInTimeZone(input.checkIn, input.timezone, "yyyy-MM-dd");
  const endDate = formatInTimeZone(input.checkOut, input.timezone, "yyyy-MM-dd");
  const lastDate = new Date(Date.parse(`${endDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const nightDate = input.operation === "EARLY_CHECKIN" ? firstDate : lastDate;
  const base = input.pricingBreakdown as { currency?: unknown; nightlyRates?: unknown } | null;
  if (!base || String(base.currency).toUpperCase() !== "USD" || !Array.isArray(base.nightlyRates)) invalid();
  const rows = (base!.nightlyRates as unknown[]).filter((row): row is { date: string; rate: number } =>
    !!row && typeof row === "object" && "date" in row && row.date === nightDate);
  if (rows.length !== 1 || typeof rows[0]!.rate !== "number") invalid();
  const text = String(rows[0]!.rate);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) invalid();
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return { nightDate, nightlyAmountMinor: Number(amount), standardStayMinutes };
}
