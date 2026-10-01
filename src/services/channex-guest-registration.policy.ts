/** Persisted ingestion provenance, never a guest-supplied channel name.
 * Existing Channex reservations qualify even if they inherited a Direct Booking
 * agreement. Do not fabricate identity verification or agreement acceptance.
 */
export function isChannexGuestRegistrationExempt(reservation: {
  externalProvider?: string | null;
  externalId?: string | null;
}): boolean {
  return reservation.externalProvider?.trim().toUpperCase() === "CHANNEX" &&
    Boolean(reservation.externalId?.trim());
}
