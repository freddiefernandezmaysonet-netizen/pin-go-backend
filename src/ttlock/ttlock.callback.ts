import crypto from "node:crypto";

export const TTLOCK_CALLBACK_ROUTE = "/webhooks/ttlock";
export const TTLOCK_CALLBACK_TOKEN_QUERY_KEY = "token";

export type TtlockCallbackFormValue = string | string[];
export type TtlockCallbackForm = Record<string, TtlockCallbackFormValue>;

export type TtlockCallbackSafeMetadata = {
  keys: string[];
  lockId: string | null;
  gatewayId: string | null;
  recordType: string | null;
  lockDate: string | null;
  serverDate: string | null;
  isOnline: string | null;
  eventType: string | null;
  notifyType: string | null;
};

function asScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return null;
}

function normalizeValue(value: unknown): TtlockCallbackFormValue | null {
  const scalar = asScalar(value);
  if (scalar !== null) {
    return scalar;
  }

  if (Array.isArray(value)) {
    const items = value
      .map(asScalar)
      .filter((item): item is string => item !== null);

    return items.length > 0 ? items : null;
  }

  return null;
}

export function normalizeTtlockCallbackForm(
  body: unknown
): TtlockCallbackForm {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const normalized: TtlockCallbackForm = {};

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;

    const normalizedValue = normalizeValue(value);
    if (normalizedValue === null) continue;

    normalized[normalizedKey] = normalizedValue;
  }

  return normalized;
}

function firstValue(
  form: TtlockCallbackForm,
  candidates: string[]
): string | null {
  for (const candidate of candidates) {
    const value = form[candidate];

    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value) && value.length > 0) {
      return value[0] ?? null;
    }
  }

  return null;
}

export function ttlockCallbackSafeMetadata(
  form: TtlockCallbackForm
): TtlockCallbackSafeMetadata {
  return {
    keys: Object.keys(form).sort(),
    lockId: firstValue(form, ["lockId", "lock_id"]),
    gatewayId: firstValue(form, ["gatewayId", "gateway_id"]),
    recordType: firstValue(form, ["recordType", "record_type"]),
    lockDate: firstValue(form, ["lockDate", "lock_date"]),
    serverDate: firstValue(form, ["serverDate", "server_date"]),
    isOnline: firstValue(form, ["isOnline", "online", "status"]),
    eventType: firstValue(form, ["eventType", "event_type", "type"]),
    notifyType: firstValue(form, ["notifyType", "notify_type"]),
  };
}

function canonicalize(form: TtlockCallbackForm): string {
  const sorted = Object.entries(form)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value].sort() : value,
    ]);

  return JSON.stringify(sorted);
}

export function ttlockCallbackFingerprint(
  form: TtlockCallbackForm
): string {
  return crypto
    .createHash("sha256")
    .update(canonicalize(form))
    .digest("hex");
}

export function ttlockCallbackTokenMatches(input: {
  expectedToken: string | undefined | null;
  receivedToken: unknown;
}): boolean {
  const expected = String(input.expectedToken ?? "").trim();
  const received = asScalar(input.receivedToken) ?? "";

  if (!expected || !received) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function isTtlockCallbackContentType(
  contentType: unknown
): boolean {
  return String(contentType ?? "")
    .toLowerCase()
    .startsWith("application/x-www-form-urlencoded");
}
