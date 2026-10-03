import type { PrismaClient } from "@prisma/client";
import { StayTimePolicyError, type StayTimeOperation } from "../pin-ai/actions/stay-time-policy";
import { createStayTimeProposal, confirmStayTimeProposal, stageStayTimeModification } from "./stay-time-proposal.service";
import type { createStayTimeCheckout } from "./stay-time-checkout.service";

type PrepareInput = { guestToken: string; operation: StayTimeOperation; requestedLocalTime: string; language: "en" | "es" };
type ConfirmInput = { guestToken: string; proposalId: string; confirmationToken: string };
type Clock = { now: () => Date; platformFeePercent: string };
export type StayTimeGuestActionDependencies = Clock & {
  client: PrismaClient;
  reconcile: (reservationId: string) => Promise<unknown>;
  /** Server-owned account-scoped adapter; no default live provider is installed. */
  createCheckout?: (input: { guestToken: string; modificationId: string }) => ReturnType<typeof createStayTimeCheckout>;
};
function reject(code: string): never { throw new StayTimePolicyError(code); }
function exact(input: object, keys: readonly string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) reject("INVALID_STAY_TIME_REQUEST");
}
function now(clock: Clock) {
  const result = clock.now();
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) reject("INVALID_STAY_TIME");
  return result;
}

/** Consent-to-execution bridge. Guest transport requires its separate disabled
 * rollout flag and reservation allowlist; the Saved Agent is unchanged. */
export async function prepareStayTimeGuestAction(db: PrismaClient, input: PrepareInput, clock: Clock) {
  exact(input, ["guestToken", "operation", "requestedLocalTime", "language"]);
  const prepared = await createStayTimeProposal(db, input, { now: now(clock), platformFeePercent: clock.platformFeePercent });
  const terms = prepared.proposal.termsSnapshot as { version: string; operation: StayTimeOperation; requestedLocalTime: string;
    currentCheckIn: string; currentCheckOut: string; proposedCheckIn: string; proposedCheckOut: string;
    pricing: { currentTotalMinor: number; proposedTotalMinor: number; additionalChargeMinor: number; currency: string } };
  if (terms.version !== "stay_time_quote_v1") reject("INVALID_STAY_TIME_TERMS");
  // Explicit projection: confirmation secret and internal cleaning/pricing evidence
  // never enter the model-visible public result.
  return {
    publicResult: { proposalId: prepared.proposal.id, operation: terms.operation, requiresGuestConfirmation: true as const,
      actionExecuted: false as const, reservationChanged: false as const, availabilityHeld: false as const,
      quote: { requestedLocalTime: terms.requestedLocalTime, currentCheckIn: terms.currentCheckIn,
        currentCheckOut: terms.currentCheckOut, proposedCheckIn: terms.proposedCheckIn, proposedCheckOut: terms.proposedCheckOut,
        currentTotalMinor: terms.pricing.currentTotalMinor, proposedTotalMinor: terms.pricing.proposedTotalMinor,
        additionalChargeMinor: terms.pricing.additionalChargeMinor, currency: terms.pricing.currency,
        expiresAt: prepared.proposal.expiresAt.toISOString(), consentText: prepared.proposal.consentText } },
    privateConfirmation: { proposalId: prepared.proposal.id, confirmationToken: prepared.confirmationToken,
      expiresAt: prepared.proposal.expiresAt.toISOString() },
  };
}
export async function confirmAndExecuteStayTimeGuestAction(input: ConfirmInput, deps: StayTimeGuestActionDependencies) {
  exact(input, ["guestToken", "proposalId", "confirmationToken"]);
  await confirmStayTimeProposal(deps.client, input, { now: now(deps), platformFeePercent: deps.platformFeePercent });
  const staged = await stageStayTimeModification(deps.client, { guestToken: input.guestToken, proposalId: input.proposalId },
    { now: now(deps), platformFeePercent: deps.platformFeePercent });
  const modification = staged.modification;
  const applied = async () => {
    const { applyGuestReservationModification } = await import("./guest-reservation-modification-apply.service.js");
    const result = await applyGuestReservationModification({ modificationId: modification.id }, {
      client: deps.client, now: () => now(deps), reconcile: deps.reconcile,
    });
    return { outcome: "APPLIED" as const, proposalId: input.proposalId, modificationId: modification.id,
      actionExecuted: true as const, reservationChanged: true as const, checkoutUrl: null,
      accessReady: false as const, idempotentReplay: result.idempotentReplay };
  };
  if (modification.status === "APPLIED") return applied();
  if (["CANCELLED", "EXPIRED", "FAILED"].includes(modification.status)) reject("STAY_TIME_ACTION_ALREADY_CLOSED");
  if (Number(modification.additionalChargeAmount) === 0) {
    if (modification.status !== "APPLYING") reject("STAY_TIME_ACTION_STATE_INVALID");
    return applied();
  }
  if (!deps.createCheckout) reject("STAY_TIME_CHECKOUT_PROVIDER_UNAVAILABLE");
  const checkout = await deps.createCheckout({ guestToken: input.guestToken, modificationId: modification.id });
  if (checkout.outcome === "CHECKOUT_READY") {
    const url = new URL(checkout.checkoutUrl);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password) reject("STAY_TIME_CHECKOUT_SESSION_MISMATCH");
  }
  // A signed payment event may win while Checkout creation/retrieval is running.
  const current = await deps.client.reservationModification.findUniqueOrThrow({ where: { id: modification.id } });
  if (current.status === "APPLIED") return applied();
  if (!["AWAITING_PAYMENT", "PAYMENT_PROCESSING", "APPLYING"].includes(current.status)) reject("STAY_TIME_ACTION_ALREADY_CLOSED");
  return { outcome: checkout.outcome, proposalId: input.proposalId, modificationId: modification.id,
    actionExecuted: false as const, reservationChanged: false as const, accessReady: false as const,
    localHoldActive: true as const, checkoutUrl: checkout.checkoutUrl,
    paymentExpiresAt: current.checkoutExpiresAt?.toISOString() ?? null, idempotentReplay: staged.idempotentReplay };
}
