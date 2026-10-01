import { StayTimePolicyError, type StayTimeOperation } from "../pin-ai/actions/stay-time-policy.js";

const MINUTE = 60_000;
function reject(code: string): never { throw new StayTimePolicyError(code); }
function millis(date: Date): number {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) reject("INVALID_STAY_TIME_PAYMENT_WINDOW");
  return date.getTime();
}
type WindowScope = {
  operation: StayTimeOperation;
  proposedCheckIn: Date;
  currentCheckOut: Date;
  guestTokenExpiresAt: Date | null;
};
function cutoff(input: WindowScope) {
  if (input.operation !== "EARLY_CHECKIN" && input.operation !== "LATE_CHECKOUT") reject("INVALID_STAY_TIME_PAYMENT_WINDOW");
  return Math.min(millis(input.operation === "EARLY_CHECKIN" ? input.proposedCheckIn : input.currentCheckOut),
    input.guestTokenExpiresAt === null ? Infinity : millis(input.guestTokenExpiresAt));
}

/** Freeze once at staging; retries may validate this deadline but never extend it. */
export function createStayTimePaymentDeadline(input: WindowScope & { stagedAt: Date }): Date {
  const stagedAt = millis(input.stagedAt);
  const deadline = Math.min(stagedAt + 60 * MINUTE, cutoff(input));
  // Leave one minute of setup headroom over Checkout's 30-minute minimum.
  if (deadline <= stagedAt + 31 * MINUTE) reject("STAY_TIME_PAYMENT_WINDOW_TOO_SHORT");
  return new Date(deadline);
}

/** Temporal validation only, never proof of payment or authority to apply.
 * Paid adapters must ALSO validate persisted consent/fingerprint, money, provider
 * evidence, availability/readiness and the exact hold before creating/applying.
 */
export function assertStayTimePaymentWindow(input: WindowScope & {
  quoteCreatedAt: Date;
  quoteExpiresAt: Date;
  confirmedAt: Date;
  stagedAt: Date;
  checkoutExpiresAt: Date;
  now: Date;
  phase: "CHECKOUT_CREATION" | "PAYMENT_APPLICATION";
}): void {
  const created = millis(input.quoteCreatedAt);
  const expiry = millis(input.quoteExpiresAt);
  const confirmed = millis(input.confirmedAt);
  const staged = millis(input.stagedAt);
  const deadline = millis(input.checkoutExpiresAt);
  const now = millis(input.now);
  if (expiry <= created || expiry - created > MINUTE || confirmed < created || confirmed >= expiry ||
      staged < confirmed || staged >= expiry || now < staged ||
      deadline <= staged || deadline > staged + 60 * MINUTE || deadline > cutoff(input) ||
      !["CHECKOUT_CREATION", "PAYMENT_APPLICATION"].includes(input.phase)) reject("INVALID_STAY_TIME_PAYMENT_WINDOW");
  if (now >= deadline) reject("STAY_TIME_PAYMENT_WINDOW_EXPIRED");
  if (input.phase === "CHECKOUT_CREATION" && deadline <= now + 31 * MINUTE) reject("STAY_TIME_PAYMENT_WINDOW_TOO_SHORT");
}
