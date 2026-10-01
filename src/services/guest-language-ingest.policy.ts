import { isChannexGuestRegistrationExempt } from "./guest-registration-channel.policy";
import type { GuestLanguage } from "./guest-language.service";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Undefined means preserve an existing language; creation uses the English default. */
export function resolveIngestGuestLanguage(input: {
  preferredLanguage?: string | null;
  externalProvider?: string | null;
  externalId?: string | null;
  externalRaw?: unknown;
}): GuestLanguage | undefined {
  if (!isChannexGuestRegistrationExempt(input)) {
    // Preserve the existing behavior for Direct Booking and other providers.
    return String(input.preferredLanguage ?? "").trim().toLowerCase() === "es" ? "es" : "en";
  }
  const customer = object(object(object(input.externalRaw).booking).customer);
  if (typeof customer.language !== "string") return undefined;
  const normalized = customer.language.trim().toLowerCase().replace(/_/g, "-");
  if (/^es(?:-[a-z0-9]+)*$/.test(normalized)) return "es";
  if (/^en(?:-[a-z0-9]+)*$/.test(normalized)) return "en";
  return undefined;
}
