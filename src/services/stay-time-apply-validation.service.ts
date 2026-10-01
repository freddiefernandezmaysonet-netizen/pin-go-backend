import type { Prisma, Reservation, ReservationModification } from "@prisma/client";
import { buildPinAIActionProposalFingerprint, canonicalPinAIActionTerms } from "../pin-ai/actions/action-proposal.service.js";
import { StayTimePolicyError } from "../pin-ai/actions/stay-time-policy.js";
import { revalidateStayTimeTerms } from "./stay-time-proposal.service.js";
import { prepareStayTimeQuoteInTransaction } from "./stay-time-quote.service.js";
import { assertStayTimePaymentWindow } from "./stay-time-payment-window.js";
import { assertStayTimePaymentEvidence, type StayTimePaymentEvidence } from "./stay-time-payment-evidence.js";

function reject(code: string): never { throw new StayTimePolicyError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("INVALID_STAY_TIME_TERMS");
  return value as Record<string, unknown>;
}
export function isStayTimeModification(confirmation: unknown): boolean {
  if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)) return false;
  const value = confirmation as Record<string, unknown>;
  return value.operation === "EARLY_CHECKIN" || value.operation === "LATE_CHECKOUT" ||
    (!!value.quoteTerms && typeof value.quoteTerms === "object" && "version" in value.quoteTerms && value.quoteTerms.version === "stay_time_quote_v1");
}

/** Runs under canonical apply's reservation/modification locks and serializable
 * transaction. Only zero-cost changes are enabled; paid stay-time remains blocked. */
export async function validateFreeStayTimeApply(tx: Prisma.TransactionClient, m: ReservationModification, r: Reservation, now: Date) {
  if (m.financialAction !== "NO_PAYMENT_REQUIRED" ||
      [m.amountDifference, m.additionalChargeAmount, m.additionalPlatformFeeAmount, m.additionalHostPayoutAmount].some(v => Number(v) !== 0) ||
      [m.stripeCheckoutSessionId, m.stripePaymentIntentId, m.stripeChargeId, m.stripeApplicationFeeId,
        m.stripeTransferId, m.stripePaymentStatus].some(Boolean)) reject("STAY_TIME_PAYMENT_APPLY_NOT_READY");
  return validateStayTimeSnapshot(tx, m, r, now);
}

/** Internal preflight only. Does not create Checkout or authorize paid apply.
 * The future payment adapter must call under its own scoped transaction and
 * handle provider session persistence, payment evidence and failure recovery.
 */
export async function validatePaidStayTimeCheckout(tx: Prisma.TransactionClient, m: ReservationModification, r: Reservation, now: Date) {
  if (m.status !== "AWAITING_PAYMENT" || m.financialAction !== "ADDITIONAL_PAYMENT_REQUIRED" ||
      Number(m.additionalChargeAmount) <= 0 || !m.checkoutExpiresAt ||
      [m.stripeCheckoutSessionId, m.stripePaymentIntentId, m.stripeChargeId, m.stripeApplicationFeeId,
        m.stripeTransferId, m.stripePaymentStatus].some(Boolean)) reject("STAY_TIME_CHECKOUT_PREFLIGHT_NOT_ELIGIBLE");
  return validateStayTimeSnapshot(tx, m, r, now, "CHECKOUT_CREATION");
}

/** Internal post-payment validation for the trusted payment processor's canonical
 * apply call. Guest routes and legacy webhooks do not supply this evidence.
 * Provider retrieval, durable turnover holds and rollout remain separate gates.
 */
export async function validatePaidStayTimeApply(tx: Prisma.TransactionClient, m: ReservationModification, r: Reservation,
  now: Date, evidence: StayTimePaymentEvidence) {
  if (m.status !== "APPLYING") reject("STAY_TIME_PAYMENT_APPLY_NOT_ELIGIBLE");
  if (m.expiredAt || m.cancelledAt) reject("STAY_TIME_PAYMENT_ALREADY_CLOSED");
  assertStayTimePaymentEvidence(m, r, evidence, now);
  return validateStayTimeSnapshot(tx, m, r, now, "PAYMENT_APPLICATION");
}

async function validateStayTimeSnapshot(tx: Prisma.TransactionClient, m: ReservationModification, r: Reservation, now: Date,
  paidPhase?: "CHECKOUT_CREATION" | "PAYMENT_APPLICATION") {
  const consent = object(m.guestConfirmation);
  const terms = object(consent.quoteTerms);
  if (m.status !== (paidPhase === "CHECKOUT_CREATION" ? "AWAITING_PAYMENT" : "APPLYING") || m.reservationId !== r.id ||
      m.requestSource !== "PIN_AI_GUEST_SERVICES" || consent.source !== m.requestSource ||
      consent.confirmed !== true || typeof consent.actionProposalId !== "string" ||
      terms.version !== "stay_time_quote_v1" || consent.operation !== terms.operation || !r.guestToken) reject("STAY_TIME_CONFIRMED_PROPOSAL_REQUIRED");
  const proposal = await tx.pinAIActionProposal.findUnique({ where: { id: consent.actionProposalId } });
  const property = await tx.property.findUnique({ where: { id: r.propertyId }, select: { organizationId: true } });
  if (!proposal || !property || proposal.status !== "CONFIRMED" || !proposal.confirmedAt ||
      proposal.actionType !== "RESERVATION_MODIFICATION" || proposal.reservationId !== r.id ||
      proposal.propertyId !== r.propertyId || proposal.organizationId !== property.organizationId ||
      proposal.cancelledAt || proposal.supersededAt || !["en", "es"].includes(proposal.language)) reject("STAY_TIME_PROPOSAL_SCOPE_MISMATCH");
  const stagedAt = typeof consent.confirmedAt === "string" ? Date.parse(consent.confirmedAt) : NaN;
  if (!Number.isFinite(stagedAt) || proposal.confirmedAt.getTime() > stagedAt || stagedAt > now.getTime() ||
      stagedAt >= proposal.expiresAt.getTime() || consent.actionProposalConfirmedAt !== proposal.confirmedAt.toISOString()) reject("STAY_TIME_CONFIRMED_PROPOSAL_REQUIRED");
  const fingerprint = buildPinAIActionProposalFingerprint({ organizationId: proposal.organizationId,
    propertyId: proposal.propertyId, reservationId: proposal.reservationId, baseReservationUpdatedAt: proposal.baseReservationUpdatedAt,
    actionType: proposal.actionType, language: proposal.language as "en" | "es", consentText: proposal.consentText,
    termsSnapshot: object(proposal.termsSnapshot) });
  if (fingerprint !== proposal.proposalFingerprint || fingerprint !== m.requestFingerprint ||
      m.baseReservationUpdatedAt.getTime() !== proposal.baseReservationUpdatedAt.getTime() ||
      fingerprint !== consent.actionProposalFingerprint || m.clientRequestId !== `stay-time:${proposal.id}` ||
      canonicalPinAIActionTerms(terms) !== canonicalPinAIActionTerms(object(proposal.termsSnapshot))) reject("STAY_TIME_PROPOSAL_FINGERPRINT_MISMATCH");
  const pricing = object(terms.pricing);
  if (!Number.isSafeInteger(pricing.platformFeeBasisPoints) || Number(pricing.platformFeeBasisPoints) < 0 ||
      Number(pricing.platformFeeBasisPoints) > 10000) reject("INVALID_STAY_TIME_TERMS");
  const platformFeePercent = (Number(pricing.platformFeeBasisPoints) / 100).toFixed(2);
  let fresh;
  if (paidPhase) {
    if ((terms.operation !== "EARLY_CHECKIN" && terms.operation !== "LATE_CHECKOUT") ||
        typeof terms.requestedLocalTime !== "string" || typeof terms.createdAt !== "string" ||
        terms.expiresAt !== proposal.expiresAt.toISOString()) reject("INVALID_STAY_TIME_TERMS");
    assertStayTimePaymentWindow({ operation: terms.operation, proposedCheckIn: m.proposedCheckIn, currentCheckOut: m.currentCheckOut,
      guestTokenExpiresAt: r.guestTokenExpiresAt, quoteCreatedAt: new Date(terms.createdAt), quoteExpiresAt: proposal.expiresAt,
      confirmedAt: proposal.confirmedAt, stagedAt: new Date(stagedAt), checkoutExpiresAt: m.checkoutExpiresAt!, now, phase: paidPhase });
    // Keep fresh operational checks at NOW, not at the earlier staging time.
    fresh = await prepareStayTimeQuoteInTransaction(tx, { guestToken: r.guestToken,
      operation: terms.operation, requestedLocalTime: terms.requestedLocalTime }, { now, platformFeePercent, ownModificationId: m.id });
    const commercial = (value: Record<string, unknown>) => {
      const { createdAt: _created, expiresAt: _expiry, ...bound } = value;
      return canonicalPinAIActionTerms(bound);
    };
    if (commercial(terms) !== commercial(fresh.terms)) reject("STAY_TIME_QUOTE_CHANGED");
  } else {
    fresh = await revalidateStayTimeTerms({ db: tx, guestToken: r.guestToken, termsSnapshot: terms,
      expiresAt: proposal.expiresAt, now }, platformFeePercent, m.id);
  }
  const p = fresh.terms.pricing;
  const ids = (values: string[]) => JSON.stringify([...values].sort());
  if ((!paidPhase && p.additionalChargeMinor !== 0) || (paidPhase && p.additionalChargeMinor <= 0) ||
      Number(m.amountDifference) !== p.additionalChargeMinor / 100 || Number(m.additionalChargeAmount) !== p.additionalChargeMinor / 100 ||
      Number(m.additionalPlatformFeeAmount) !== p.additionalPlatformFeeMinor / 100 ||
      Number(m.additionalHostPayoutAmount) !== p.additionalHostPayoutMinor / 100 ||
      m.currentCheckIn.toISOString() !== fresh.terms.currentCheckIn ||
      m.currentCheckOut.toISOString() !== fresh.terms.currentCheckOut || m.proposedCheckIn.toISOString() !== fresh.terms.proposedCheckIn ||
      m.proposedCheckOut.toISOString() !== fresh.terms.proposedCheckOut || m.currency.toUpperCase() !== p.currency ||
      Number(m.currentTotalAmount) !== p.currentTotalMinor / 100 || Number(m.proposedTotalAmount) !== p.proposedTotalMinor / 100 ||
      m.currentAdults !== r.adults || m.proposedAdults !== r.adults || m.currentChildren !== r.children || m.proposedChildren !== r.children ||
      ids(m.currentSelectedAmenityIds) !== ids(r.selectedAmenityIds) || ids(m.proposedSelectedAmenityIds) !== ids(r.selectedAmenityIds) ||
      canonicalPinAIActionTerms(object(m.currentPricing)) !== canonicalPinAIActionTerms(p.basePricingSnapshot)) reject("STAY_TIME_MODIFICATION_TERMS_MISMATCH");
  const expectedPricing = { ...p.basePricingSnapshot, totalAmount: p.proposedTotalMinor / 100, totalAmountCents: p.proposedTotalMinor,
    stayTimeAdjustments: [...(Array.isArray(p.basePricingSnapshot.stayTimeAdjustments) ? p.basePricingSnapshot.stayTimeAdjustments : []), {
      proposalId: proposal.id, operation: fresh.terms.operation, serviceSubtotalMinor: p.serviceSubtotalMinor,
      taxes: p.taxes, taxTotalMinor: p.taxTotalMinor, additionalChargeMinor: p.additionalChargeMinor,
    }] };
  if (canonicalPinAIActionTerms(object(m.proposedPricing)) !== canonicalPinAIActionTerms(expectedPricing)) reject("STAY_TIME_MODIFICATION_TERMS_MISMATCH");
  return { operation: fresh.terms.operation, requiredFreeUntil: new Date(fresh.terms.requiredFreeUntil) };
}
