import type { StayTimeRule } from "./stay-time-policy.js";

export type StayTimeSettings = Readonly<{
  earlyCheckin: StayTimeRule;
  lateCheckout: StayTimeRule;
}>;
export class StayTimeSettingsError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
function invalid(): never { throw new StayTimeSettingsError("STAY_TIME_SETTINGS_INVALID"); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== fields.length || fields.some(key => !Object.hasOwn(data, key)) ||
      Object.keys(data).some(key => !fields.includes(key))) invalid();
  return data;
}
export function defaultStayTimeSettings(): StayTimeSettings {
  return {
    earlyCheckin: { enabled: false, limitLocalTime: "12:00", fee: { mode: "FREE", amountMinor: 0, currency: "USD" } },
    lateCheckout: { enabled: false, limitLocalTime: "14:00", fee: { mode: "FREE", amountMinor: 0, currency: "USD" } },
  };
}
export function parseStayTimeSettings(value: unknown): StayTimeSettings {
  const settings = object(value, ["earlyCheckin", "lateCheckout"]);
  function rule(value: unknown): StayTimeRule {
    const data = object(value, ["enabled", "limitLocalTime", "fee"]);
    const fee = object(data.fee, ["mode", "amountMinor", "currency"]);
    if (typeof data.enabled !== "boolean" || typeof data.limitLocalTime !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data.limitLocalTime) ||
        (fee.mode !== "FREE" && fee.mode !== "FIXED" && fee.mode !== "PER_HOUR") ||
        typeof fee.amountMinor !== "number" || !Number.isSafeInteger(fee.amountMinor) ||
        fee.amountMinor < 0 || fee.amountMinor > 99_999_999 || fee.currency !== "USD" ||
        (fee.mode === "FREE" ? fee.amountMinor !== 0 : fee.amountMinor === 0)) invalid();
    return { enabled: data.enabled, limitLocalTime: data.limitLocalTime,
      fee: { mode: fee.mode, amountMinor: fee.amountMinor, currency: "USD" } };
  }
  return { earlyCheckin: rule(settings.earlyCheckin), lateCheckout: rule(settings.lateCheckout) };
}
export function parseStayTimeSettingsUpdate(value: unknown) {
  const body = object(value, ["expectedRevision", "settings"]);
  if (typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0 || body.expectedRevision >= 2_147_483_647) invalid();
  return { expectedRevision: body.expectedRevision, settings: parseStayTimeSettings(body.settings) };
}
export function validateStayTimeSettingsLimits(settings: StayTimeSettings, checkIn: string, checkOut: string) {
  if (![checkIn, checkOut].every(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new StayTimeSettingsError("STAY_TIME_PROPERTY_HOURS_INVALID", 409);
  }
  if ((settings.earlyCheckin.enabled && settings.earlyCheckin.limitLocalTime >= checkIn) ||
      (settings.lateCheckout.enabled && settings.lateCheckout.limitLocalTime <= checkOut)) {
    throw new StayTimeSettingsError("STAY_TIME_LIMIT_OUTSIDE_PROPERTY_HOURS");
  }
}
