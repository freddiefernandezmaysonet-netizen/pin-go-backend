import { PinAIActionProposalType, Prisma, type PrismaClient } from "@prisma/client";
import { STAY_TIME_QUOTE_TTL_MS } from "./stay-time-quote-window.js";
import {
  canonicalPinAIActionTerms, createPinAIActionProposal, confirmPinAIActionProposal,
  buildPinAIActionProposalFingerprint,
  type StayTimeProposalValidator,
} from "../pin-ai/actions/action-proposal.service.js";
import { StayTimePolicyError, type StayTimeOperation } from "../pin-ai/actions/stay-time-policy.js";
import { prepareStayTimeQuote, prepareStayTimeQuoteInTransaction } from "./stay-time-quote.service.js";
import { createStayTimePaymentDeadline, assertStayTimePaymentWindow } from "./stay-time-payment-window.js";

type Options = { now?: Date; platformFeePercent: string };
function reject(code: string): never { throw new StayTimePolicyError(code); }

/** Price/state comparison excludes only observation timestamps, never commercial terms. */
function comparable(terms: Record<string, unknown>) {
  const { createdAt: _created, expiresAt: _expires, ...bound } = terms;
  return canonicalPinAIActionTerms(bound);
}

function validator(platformFeePercent: string): StayTimeProposalValidator {
  return async input => { await revalidateStayTimeTerms(input, platformFeePercent); };
}

export async function revalidateStayTimeTerms({ db, guestToken, termsSnapshot, expiresAt, now }: Parameters<StayTimeProposalValidator>[0], platformFeePercent: string, ownModificationId?: string) {
    if (!termsSnapshot || typeof termsSnapshot !== "object" || Array.isArray(termsSnapshot)) reject("INVALID_STAY_TIME_TERMS");
    const terms = termsSnapshot as Record<string, unknown>;
    if (terms.version !== "stay_time_quote_v1" ||
        (terms.operation !== "EARLY_CHECKIN" && terms.operation !== "LATE_CHECKOUT") ||
        typeof terms.requestedLocalTime !== "string" || typeof terms.createdAt !== "string" ||
        typeof terms.expiresAt !== "string") reject("INVALID_STAY_TIME_TERMS");
    const created = Date.parse(terms.createdAt);
    const expiry = Date.parse(terms.expiresAt);
    if (!Number.isFinite(created) || !Number.isFinite(expiry) || created > now.getTime() ||
        expiry <= now.getTime() || expiry <= created || expiry - created > STAY_TIME_QUOTE_TTL_MS ||
        expiresAt.getTime() !== expiry) reject("STAY_TIME_QUOTE_EXPIRED");
    const fresh = await prepareStayTimeQuoteInTransaction(db, {
      guestToken, operation: terms.operation, requestedLocalTime: terms.requestedLocalTime,
    }, { now, platformFeePercent, ...(ownModificationId !== undefined ? { ownModificationId } : {}) });
    if (comparable(terms) !== comparable(fresh.terms)) reject("STAY_TIME_QUOTE_CHANGED");
    return fresh;
}

/** Internal only until payment/apply is ready. Creates consent, never a reservation hold. */
export async function createStayTimeProposal(db: PrismaClient, input: {
  guestToken: string; operation: StayTimeOperation; requestedLocalTime: string; language: "en" | "es";
}, options: Options) {
  const now = options.now ?? new Date();
  const quote = await prepareStayTimeQuote(db, input, { ...options, now });
  const amount = (quote.terms.pricing.additionalChargeMinor / 100).toFixed(2);
  const consentText = input.language === "es"
    ? `Confirmo ${input.operation === "EARLY_CHECKIN" ? "la entrada anticipada" : "la salida tardía"} a las ${input.requestedLocalTime}, hora de la propiedad, por USD ${amount} adicionales, impuestos incluidos. La confirmación no cambia la reserva ni habilita el acceso; el cambio requiere su aplicación y, si corresponde, el pago.`
    : `I confirm ${input.operation === "EARLY_CHECKIN" ? "early check-in" : "late checkout"} at ${input.requestedLocalTime}, property local time, for an additional USD ${amount}, including taxes. Confirmation does not change the reservation or enable access; the change requires application and payment when applicable.`;
  const result = await createPinAIActionProposal({ prisma: db, guestToken: input.guestToken,
    actionType: PinAIActionProposalType.RESERVATION_MODIFICATION, language: input.language,
    consentText, termsSnapshot: quote.terms, expiresAt: new Date(quote.terms.expiresAt), now,
    validateStayTime: validator(options.platformFeePercent) });
  return { ...result, paymentReady: false as const, authorizationGranted: false as const, availabilityHeld: false as const };
}

/** Explicit guest token + one-time proposal token. Serializable revalidation precedes consent. */
export async function confirmStayTimeProposal(db: PrismaClient, input: {
  guestToken: string; proposalId: string; confirmationToken: string;
}, options: Options) {
  const result = await confirmPinAIActionProposal({ prisma: db, ...input, ...(options.now !== undefined ? { now: options.now } : {}),
    validateStayTime: validator(options.platformFeePercent) });
  return { ...result, paymentReady: false as const, authorizationGranted: false as const, availabilityHeld: false as const };
}

/** Internal handoff only. Free canonical apply has a dedicated validator;
 * paid checkout/apply and full worker reconciliation remain gated. */
export async function stageStayTimeModification(db: PrismaClient, input: {
  guestToken: string; proposalId: string;
}, options: Options) {
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(input.guestToken) || !/^[A-Za-z0-9_-]{8,128}$/.test(input.proposalId)) reject("INVALID_STAY_TIME_REQUEST");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) reject("INVALID_STAY_TIME");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Reservation" WHERE "guestToken" = ${input.guestToken} FOR UPDATE
        `;
        if (!rows[0]) reject("STAY_TIME_RESERVATION_NOT_FOUND");
        const reservation = await tx.reservation.findFirst({ where: { id: rows[0].id,
          guestToken: input.guestToken, status: "ACTIVE", paymentState: "PAID",
          property: { status: "ACTIVE" }, OR: [{ guestTokenExpiresAt: null }, { guestTokenExpiresAt: { gt: now } }] },
          include: { property: { select: { organizationId: true } } } });
        if (!reservation) reject("STAY_TIME_RESERVATION_NOT_FOUND");
        await tx.$queryRaw`SELECT "id" FROM "PinAIActionProposal" WHERE "id" = ${input.proposalId} FOR UPDATE`;
        const proposal = await tx.pinAIActionProposal.findUnique({ where: { id: input.proposalId } });
        if (!proposal || proposal.reservationId !== reservation.id || proposal.propertyId !== reservation.propertyId ||
            proposal.organizationId !== reservation.property.organizationId) reject("STAY_TIME_PROPOSAL_NOT_FOUND");
        if (proposal.actionType !== "RESERVATION_MODIFICATION" || proposal.status !== "CONFIRMED" ||
            !proposal.confirmedAt || proposal.confirmedAt > now || proposal.confirmedAt < proposal.createdAt ||
            proposal.confirmedAt >= proposal.expiresAt || proposal.cancelledAt || proposal.supersededAt) reject("STAY_TIME_CONFIRMED_PROPOSAL_REQUIRED");
        const terms = proposal.termsSnapshot as Record<string, unknown>;
        if (!terms || terms.version !== "stay_time_quote_v1" || !["en", "es"].includes(proposal.language)) reject("INVALID_STAY_TIME_TERMS");
        const fingerprint = buildPinAIActionProposalFingerprint({ organizationId: proposal.organizationId,
          propertyId: proposal.propertyId, reservationId: proposal.reservationId, baseReservationUpdatedAt: proposal.baseReservationUpdatedAt,
          actionType: proposal.actionType, language: proposal.language as "en" | "es", consentText: proposal.consentText, termsSnapshot: terms });
        if (fingerprint !== proposal.proposalFingerprint) reject("STAY_TIME_PROPOSAL_FINGERPRINT_MISMATCH");
        const clientRequestId = `stay-time:${proposal.id}`;
        const existing = await tx.reservationModification.findUnique({ where: {
          reservationId_clientRequestId: { reservationId: reservation.id, clientRequestId },
        } });
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) reject("STAY_TIME_REQUEST_REUSED");
          return { modification: existing, idempotentReplay: true, paymentReady: false as const, actionExecuted: false as const };
        }
        const fresh = await revalidateStayTimeTerms({ db: tx, guestToken: input.guestToken, termsSnapshot: terms,
          expiresAt: proposal.expiresAt, now }, options.platformFeePercent);
        // Host review is also an active modification even when it has no payment hold.
        if (await tx.reservationModification.findFirst({ where: { reservationId: reservation.id,
          status: "HOST_APPROVAL_REQUIRED" }, select: { id: true } })) reject("RESERVATION_CHANGE_IN_PROGRESS");
        const pricing = fresh.terms.pricing;
        const paid = pricing.additionalChargeMinor > 0;
        const paymentScope = { operation: fresh.terms.operation, proposedCheckIn: new Date(fresh.terms.proposedCheckIn),
          currentCheckOut: new Date(fresh.terms.currentCheckOut), guestTokenExpiresAt: reservation.guestTokenExpiresAt };
        const checkoutExpiresAt = paid ? createStayTimePaymentDeadline({ ...paymentScope, stagedAt: now }) : null;
        if (checkoutExpiresAt) assertStayTimePaymentWindow({ ...paymentScope,
          quoteCreatedAt: new Date(String(terms.createdAt)), quoteExpiresAt: proposal.expiresAt,
          confirmedAt: proposal.confirmedAt, stagedAt: now, checkoutExpiresAt, now, phase: "CHECKOUT_CREATION" });
        if (pricing.basePricingSnapshot.stayTimeAdjustments !== undefined &&
            !Array.isArray(pricing.basePricingSnapshot.stayTimeAdjustments)) reject("STAY_TIME_PRICING_SNAPSHOT_MISMATCH");
        const proposedPricing = { ...pricing.basePricingSnapshot, totalAmount: pricing.proposedTotalMinor / 100,
          totalAmountCents: pricing.proposedTotalMinor,
          stayTimeAdjustments: [...(Array.isArray(pricing.basePricingSnapshot.stayTimeAdjustments)
            ? pricing.basePricingSnapshot.stayTimeAdjustments : []), {
            proposalId: proposal.id, operation: fresh.terms.operation, serviceSubtotalMinor: pricing.serviceSubtotalMinor,
            taxes: pricing.taxes, taxTotalMinor: pricing.taxTotalMinor, additionalChargeMinor: pricing.additionalChargeMinor,
          }] };
        const modification = await tx.reservationModification.create({ data: {
          reservationId: reservation.id, clientRequestId, requestFingerprint: fingerprint,
          status: paid ? "AWAITING_PAYMENT" : "APPLYING", financialAction: pricing.financialAction,
          requestSource: "PIN_AI_GUEST_SERVICES", baseReservationUpdatedAt: reservation.updatedAt,
          currentCheckIn: reservation.checkIn, currentCheckOut: reservation.checkOut,
          proposedCheckIn: new Date(fresh.terms.proposedCheckIn), proposedCheckOut: new Date(fresh.terms.proposedCheckOut),
          currentAdults: reservation.adults, proposedAdults: reservation.adults,
          currentChildren: reservation.children, proposedChildren: reservation.children,
          currentSelectedAmenityIds: reservation.selectedAmenityIds, proposedSelectedAmenityIds: reservation.selectedAmenityIds,
          currentPricing: pricing.basePricingSnapshot as Prisma.InputJsonValue, proposedPricing: proposedPricing as Prisma.InputJsonValue,
          guestConfirmation: { operation: fresh.terms.operation, confirmed: true, confirmedAt: now.toISOString(),
            source: "PIN_AI_GUEST_SERVICES", actionProposalId: proposal.id, actionProposalFingerprint: fingerprint,
            actionProposalConfirmedAt: proposal.confirmedAt.toISOString(), quoteTerms: terms as Prisma.InputJsonValue },
          currentTotalAmount: pricing.currentTotalMinor / 100, proposedTotalAmount: pricing.proposedTotalMinor / 100,
          amountDifference: pricing.additionalChargeMinor / 100, additionalChargeAmount: pricing.additionalChargeMinor / 100,
          additionalPlatformFeeAmount: pricing.additionalPlatformFeeMinor / 100,
          additionalHostPayoutAmount: pricing.additionalHostPayoutMinor / 100, currency: pricing.currency.toLowerCase(), checkoutExpiresAt,
        } });
        return { modification, idempotentReplay: false, paymentReady: false as const, actionExecuted: false as const };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2034" || (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))))) continue;
      throw error;
    }
  }
  return reject("STAY_TIME_CONCURRENT_CHANGE");
}
