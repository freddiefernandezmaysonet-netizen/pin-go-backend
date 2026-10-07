// Version changes require renewed explicit acceptance; amounts are fixed server-side.
export const PIN_AI_BILLING_TERMS = Object.freeze({
  version: "pin-ai-connect-usd-1-reservation-v1",
  amountCents: 100,
  currency: "USD",
  appliesTo: ["ALL_RESERVATION_ORIGINS"],
  collectionMethod: "STRIPE_CONNECT_BALANCE_DEBIT",
  startsBeforeCheckInHours: 24,
  oncePerReservation: true,
  manualReservationsIncluded: true,
});
