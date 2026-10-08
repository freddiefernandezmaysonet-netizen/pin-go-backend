/** Controls *guest-directed* external SMS/email only; never suppress Channex inbox traffic. */
export type OtaGuestExternalChannel = "sms" | "email";
export type ChannexOperationalProvider = "AIRBNB" | "BOOKING_COM";

export function resolveChannexOperationalProvider(reservation: {
  source?: string | null;
  externalProvider?: string | null;
  externalId?: string | null;
}): ChannexOperationalProvider | null {
  if (String(reservation.externalProvider ?? "").trim().toUpperCase() !== "CHANNEX" ||
      !String(reservation.externalId ?? "").trim()) return null;
  const source = String(reservation.source ?? "").trim().toUpperCase().replace(/[.\s-]/g, "_");
  if (source === "AIRBNB" || source === "AIR_BNB") return "AIRBNB";
  if (source === "BOOKING_COM" || source === "BOOKINGCOM") return "BOOKING_COM";
  return null;
}

export function isOtaGuestExternalDeliveryBlocked(
  reservation: { source?: string | null; externalProvider?: string | null; externalId?: string | null },
  channel: OtaGuestExternalChannel,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const provider = resolveChannexOperationalProvider(reservation);
  if (!provider || (channel !== "sms" && channel !== "email")) return false;
  const blocked = String(env.OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS ?? "")
    .split(",").map(s => s.trim().toUpperCase().replace(/[.\s-]/g, "_"))
    .map(s => s === "BOOKINGCOM" ? "BOOKING_COM" : s === "AIR_BNB" ? "AIRBNB" : s);
  // Unset by default: existing production behavior is unchanged.
  return blocked.includes(provider);
}
