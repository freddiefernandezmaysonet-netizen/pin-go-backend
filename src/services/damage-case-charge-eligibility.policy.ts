/** Pure, non-executing policy. Never use its result as a payment instruction.
 * A future caller must load trusted current state, atomically claim execution,
 * validate provider readiness and persist/reconcile payment attempts separately.
 * Money is supplied as integer minor units, never floating point major units.
 */
export const DAMAGE_PAYMENT_AUTHORIZATION_VERSION = "PROPERTY_PROTECTION_PAYMENT_AUTHORIZATION_V1";

export interface DamageChargeEligibilityInput {
  now: Date;
  checkOut: Date;
  directBooking: boolean;
  protectionEnabled: boolean;
  protectionMode: string;
  organizationId: string;
  reservationId: string;
  damageCaseId: string;
  connectedAccountId: string;
  status: string;
  closedAt: Date | null;
  guestResponse: string;
  hostApprovedAt: Date | null;
  hostApprovedByUserId: string | null;
  guestNotifiedAt: Date | null;
  claimRevision: string;
  approvedAmountMinor: number;
  acceptedMaximumMinor: number;
  currency: string;
  maximumCurrency: string;
  authorization: null | {
    version: string;
    action: string;
    organizationId: string;
    reservationId: string;
    damageCaseId: string;
    connectedAccountId: string;
    claimRevision: string;
    amountMinor: number;
    currency: string;
    authorizedAt: Date;
  };
}

function time(value: unknown): number {
  return value instanceof Date ? value.getTime() : NaN;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function positiveMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function evaluateDamageChargeEligibility(input: DamageChargeEligibilityInput) {
  const blocked = (reason: string) => ({ eligible: false as const, reason });
  const now = time(input.now);
  const checkout = time(input.checkOut);
  if (!Number.isFinite(now) || !Number.isFinite(checkout) || now <= checkout)
    return blocked("CHECKOUT_REQUIRED");
  if (input.directBooking !== true || input.protectionEnabled !== true || input.protectionMode !== "CARD_ON_FILE")
    return blocked("PROTECTION_NOT_ELIGIBLE");
  if (![input.organizationId, input.reservationId, input.damageCaseId, input.connectedAccountId, input.claimRevision].every(identifier))
    return blocked("SCOPE_REQUIRED");
  if (input.closedAt !== null || input.status !== "GUEST_NOTIFIED")
    return blocked("CASE_NOT_OPEN_FOR_PAYMENT");
  if (input.guestResponse !== "ACCEPTED") return blocked("GUEST_ACCEPTANCE_REQUIRED");
  const approved = time(input.hostApprovedAt);
  const notified = time(input.guestNotifiedAt);
  if (!identifier(input.hostApprovedByUserId) || !Number.isFinite(approved) || approved <= checkout || approved > now)
    return blocked("HOST_APPROVAL_REQUIRED");
  if (!Number.isFinite(notified) || notified < approved || notified > now)
    return blocked("GUEST_NOTIFICATION_REQUIRED");
  if (!positiveMinor(input.approvedAmountMinor) || !positiveMinor(input.acceptedMaximumMinor))
    return blocked("INVALID_AMOUNT");
  // V1 existing consent snapshots are USD. Do not infer support for other currencies.
  if (input.currency !== "usd" || input.maximumCurrency !== input.currency)
    return blocked("CURRENCY_NOT_SUPPORTED");
  if (input.approvedAmountMinor > input.acceptedMaximumMinor) return blocked("LIABILITY_LIMIT_EXCEEDED");
  const auth = input.authorization;
  if (!auth || auth.version !== DAMAGE_PAYMENT_AUTHORIZATION_VERSION || auth.action !== "ACCEPT_AND_AUTHORIZE_PAYMENT")
    return blocked("PAYMENT_AUTHORIZATION_REQUIRED");
  if (auth.organizationId !== input.organizationId || auth.reservationId !== input.reservationId ||
      auth.damageCaseId !== input.damageCaseId || auth.connectedAccountId !== input.connectedAccountId)
    return blocked("AUTHORIZATION_SCOPE_MISMATCH");
  if (auth.claimRevision !== input.claimRevision || auth.amountMinor !== input.approvedAmountMinor || auth.currency !== input.currency)
    return blocked("AUTHORIZATION_TERMS_MISMATCH");
  const authorized = time(auth.authorizedAt);
  if (!Number.isFinite(authorized) || authorized < notified || authorized > now)
    return blocked("AUTHORIZATION_TIME_INVALID");
  return { eligible: true as const, reason: "POLICY_ELIGIBLE" as const };
}
