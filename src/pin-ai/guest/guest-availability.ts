const DAY_MS = 24 * 60 * 60 * 1000;

// Reservation timestamps are canonical instants derived from the property's
// timezone. Use elapsed 24 hours, not server-local calendar days (DST safe).
export function guestPinAIAvailability(input: {
  checkIn: Date; checkOut: Date; status: string;
}, now: Date) {
  const start = input.checkIn?.getTime();
  const end = input.checkOut?.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      !Number.isFinite(now.getTime())) {
    return { available: false, opensAt: null, closesAt: null };
  }
  const opensAt = new Date(start - DAY_MS);
  const closesAt = new Date(end + DAY_MS);
  return { available: input.status === "ACTIVE" && now >= opensAt && now < closesAt,
    opensAt, closesAt };
}
