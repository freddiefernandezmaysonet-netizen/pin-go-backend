/** Guest-directed external SMS/email policy. Channex inbox messages are not external delivery. */
export type OtaGuestExternalChannel = "sms" | "email";

export function isOtaGuestExternalDeliveryBlocked(
  reservation: { source?: string | null; externalProvider?: string | null; externalId?: string | null },
  channel: OtaGuestExternalChannel,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Fail open until explicitly configured; preserve existing Direct Booking behavior.
  if (reservation.externalProvider?.trim().toUpperCase() !== "CHANNEX" ||
      !reservation.externalId?.trim()) return false;
  const source = String(reservation.source ?? "").trim().toUpperCase().replace(/[.\s-]/g, "_");
  const provider = source === "BOOKINGCOM" || source === "BOOKING_COM" ? "BOOKING_COM"
    : source === "AIR_BNB" || source === "AIRBNB" ? "AIRBNB" : source;
  const blocked = (env.OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS ?? "")
    .split(",").map(s => s.trim().toUpperCase().replace(/[.\s-]/g, "_"))
    .map(s => s === "BOOKINGCOM" ? "BOOKING_COM" : s === "AIR_BNB" ? "AIRBNB" : s);
  return (channel === "sms" || channel === "email") && blocked.includes(provider);
}
