import { PinAIActionProposalType, type PrismaClient } from "@prisma/client";
import {
  canonicalPinAIActionTerms, createPinAIActionProposal, confirmPinAIActionProposal,
  type StayTimeProposalValidator,
} from "../pin-ai/actions/action-proposal.service.js";
import { StayTimePolicyError, type StayTimeOperation } from "../pin-ai/actions/stay-time-policy.js";
import { prepareStayTimeQuote, prepareStayTimeQuoteInTransaction } from "./stay-time-quote.service.js";

type Options = { now?: Date; platformFeePercent: string };
function reject(code: string): never { throw new StayTimePolicyError(code); }

/** Price/state comparison excludes only observation timestamps, never commercial terms. */
function comparable(terms: Record<string, unknown>) {
  const { createdAt: _created, expiresAt: _expires, ...bound } = terms;
  return canonicalPinAIActionTerms(bound);
}

function validator(platformFeePercent: string): StayTimeProposalValidator {
  return async ({ db, guestToken, termsSnapshot, expiresAt, now }) => {
    if (!termsSnapshot || typeof termsSnapshot !== "object" || Array.isArray(termsSnapshot)) reject("INVALID_STAY_TIME_TERMS");
    const terms = termsSnapshot as Record<string, unknown>;
    if (terms.version !== "stay_time_quote_v1" ||
        (terms.operation !== "EARLY_CHECKIN" && terms.operation !== "LATE_CHECKOUT") ||
        typeof terms.requestedLocalTime !== "string" || typeof terms.createdAt !== "string" ||
        typeof terms.expiresAt !== "string") reject("INVALID_STAY_TIME_TERMS");
    const created = Date.parse(terms.createdAt);
    const expiry = Date.parse(terms.expiresAt);
    if (!Number.isFinite(created) || !Number.isFinite(expiry) || created > now.getTime() ||
        expiry <= now.getTime() || expiry <= created || expiry - created > 60_000 ||
        expiresAt.getTime() !== expiry) reject("STAY_TIME_QUOTE_EXPIRED");
    const fresh = await prepareStayTimeQuoteInTransaction(db, {
      guestToken, operation: terms.operation, requestedLocalTime: terms.requestedLocalTime,
    }, { now, platformFeePercent });
    if (comparable(terms) !== comparable(fresh.terms)) reject("STAY_TIME_QUOTE_CHANGED");
  };
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
  const result = await confirmPinAIActionProposal({ prisma: db, ...input, now: options.now,
    validateStayTime: validator(options.platformFeePercent) });
  return { ...result, paymentReady: false as const, authorizationGranted: false as const, availabilityHeld: false as const };
}
