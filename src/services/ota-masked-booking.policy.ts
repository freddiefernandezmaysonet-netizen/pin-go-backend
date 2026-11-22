const masked = (value: unknown) => typeof value === "string" && value.trim() === "***";

export function unmaskChannexContact(value: string | null | undefined) {
  return masked(value) ? null : value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

// Only the announced personal-data fields and supported contact aliases are restored.
// Null and omitted fields retain their incoming semantics; dates/status/prices are never merged.
export function preserveChannexMaskedBooking(provider: string | null | undefined, incoming: any, previous?: unknown): any {
  if (String(provider ?? "").toUpperCase() !== "CHANNEX") return incoming;
  const envelope = record(incoming);
  const booking = record(envelope?.booking);
  if (!envelope || !booking) return incoming;
  const prior = record(record(previous)?.booking);
  const restore = (current: Record<string, unknown>, old: Record<string, unknown> | null, fields: string[]) => {
    const result = { ...current };
    for (const key of fields) {
      if (masked(current[key])) result[key] = old?.[key] == null || masked(old[key]) ? null : old[key];
    }
    return result;
  };
  const result = restore(booking, prior, ["guest_email", "guestEmail", "guest_phone", "guestPhone", "notes", "raw_message", "remarks", "special_request"]);
  for (const key of ["customer", "guest"]) {
    const current = record(booking[key]);
    if (current) result[key] = restore(current, record(prior?.[key]), ["mail", "email", "phone", "address", "city", "state", "zip", "country"]);
  }
  return { ...envelope, booking: result };
}
