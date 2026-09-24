type ChannexBookingFields = {
  guestEmail: string | null;
  guestPhone: string | null;
  totalAmount: number | null;
  currency: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Read fields retained in the original Channex revision after canonical parsing. */
export function readChannexBookingFields(externalRaw: unknown): ChannexBookingFields {
  const raw = record(externalRaw);
  if (raw.provider !== "CHANNEX") {
    return { guestEmail: null, guestPhone: null, totalAmount: null, currency: null };
  }
  const booking = record(raw.booking);
  const customer = record(booking.customer);
  const guest = record(booking.guest);
  const amountValue = booking.amount;
  const amount = typeof amountValue === "number"
    ? amountValue
    : typeof amountValue === "string" && /^\d+(?:\.\d+)?$/.test(amountValue.trim())
      ? Number(amountValue.trim())
      : null;
  const currency = nonempty(booking.currency);

  return {
    guestEmail: nonempty(booking.guest_email) ??
      nonempty(booking.guestEmail) ??
      nonempty(customer.email) ??
      nonempty(customer.mail) ??
      nonempty(guest.email),
    guestPhone: nonempty(booking.guest_phone) ??
      nonempty(booking.guestPhone) ??
      nonempty(customer.phone) ??
      nonempty(guest.phone),
    totalAmount: amount !== null && Number.isFinite(amount) && amount >= 0
      ? amount
      : null,
    currency: currency && /^[A-Za-z]{3}$/.test(currency)
      ? currency.toLowerCase()
      : null,
  };
}
