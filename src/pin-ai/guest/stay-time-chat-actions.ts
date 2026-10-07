import { commercialStayTimeChatEnabled } from "./stay-time-commercial-policy.js";
import { formatInTimeZone } from "date-fns-tz";
import type { PrismaClient } from "@prisma/client";
import type { PinAIActionBrokerPrepareResult, PinAIActionBrokerExecuteResult } from "../actions/action-broker.service.js";
import { resolvePinAIActionCanaryScope } from "../actions/action-canary-scope.js";
import { StayTimePolicyError, type StayTimeOperation } from "../actions/stay-time-policy.js";
import type { prepareStayTimeGuestAction, confirmAndExecuteStayTimeGuestAction,
  StayTimeGuestActionDependencies } from "../../services/stay-time-guest-action.service.js";

export function stayTimeChatEnabled(reservationId: string, env: NodeJS.ProcessEnv): boolean {
  return env.PIN_AI_STAY_TIME_CHAT_ENABLED === "true" &&
    resolvePinAIActionCanaryScope({ reservationId, env }).enabled;
}

export function actionModificationRequestId(proposal: { id: string; termsSnapshot?: unknown }): string {
  const terms = proposal.termsSnapshot;
  return terms && typeof terms === "object" && "version" in terms && terms.version === "stay_time_quote_v1"
    ? `stay-time:${proposal.id}` : `pin_ai_${proposal.id}`;
}

type Dependencies = {
  client: PrismaClient;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  platformFeePercent: string;
  prepare?: typeof prepareStayTimeGuestAction;
  execute?: typeof confirmAndExecuteStayTimeGuestAction;
  execution?: () => Promise<StayTimeGuestActionDependencies>;
};
function reject(code: string): never { throw new StayTimePolicyError(code); }

/** Chat projection only. Confirmation credentials never enter publicResult.
 * Execution providers are injected and are never constructed by preparation. */
export function createStayTimeChatActions(deps: Dependencies) {
  async function scope(guestToken: string) {
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(guestToken)) reject("INVALID_GUEST_TOKEN");
    const reservation = await deps.client.reservation.findFirst({
      where: { guestToken, guestTokenExpiresAt: { gt: deps.now() }, status: "ACTIVE", property: { status: "ACTIVE" } },
      select: { id: true, propertyId: true, property: { select: { organizationId: true, timezone: true } } },
    });
    if (!reservation) reject("STAY_TIME_RESERVATION_NOT_FOUND");
    if (!await commercialStayTimeChatEnabled(deps.client, deps.env, { reservationId: reservation.id, propertyId: reservation.propertyId, organizationId: reservation.property.organizationId }, deps.now())) reject("STAY_TIME_CHAT_DISABLED");
    if (!reservation.property.timezone) reject("STAY_TIME_TIMEZONE_REQUIRED");
    return reservation;
  }
  return {
    async prepare(input: { guestToken: string; operation: StayTimeOperation; requestedLocalTime: string; language: "en" | "es" },
      expectedScope: { organizationId: string; propertyId: string; reservationId: string }): Promise<PinAIActionBrokerPrepareResult> {
      const reservation = await scope(input.guestToken);
      if (reservation.id !== expectedScope.reservationId || reservation.propertyId !== expectedScope.propertyId ||
          reservation.property.organizationId !== expectedScope.organizationId) reject("STAY_TIME_PROPOSAL_NOT_FOUND");
      const observedAt = deps.now();
      const prepare = deps.prepare ?? (await import("../../services/stay-time-guest-action.service.js")).prepareStayTimeGuestAction;
      const prepared = await prepare(deps.client, input, deps);
      const p = prepared.publicResult, q = p.quote;
      if (p.proposalId !== prepared.privateConfirmation.proposalId) reject("INVALID_STAY_TIME_TERMS");
      const expiresAt = new Date(q.expiresAt);
      const timezone = reservation.property.timezone!;
      return {
        publicResult: { actionType: "RESERVATION_MODIFICATION", proposalId: p.proposalId,
          requiresGuestConfirmation: true, actionExecuted: false,
          quote: { quotedAt: observedAt, quoteExpiresAt: expiresAt,
            quoteExpiresAtLocal: formatInTimeZone(expiresAt, timezone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
            priceGuaranteedUntil: expiresAt, propertyTimezone: timezone, availabilityCheckedAt: observedAt, availabilityHeld: false,
            currentTotalAmount: q.currentTotalMinor / 100, proposedTotalAmount: q.proposedTotalMinor / 100,
            amountDifference: q.additionalChargeMinor / 100, amountDifferenceCents: q.additionalChargeMinor,
            currency: q.currency, financialAction: q.additionalChargeMinor === 0 ? "NO_PAYMENT_REQUIRED" : "ADDITIONAL_PAYMENT_REQUIRED",
            stayTime: { operation: p.operation, requestedLocalTime: q.requestedLocalTime,
              currentCheckIn: q.currentCheckIn, currentCheckOut: q.currentCheckOut,
              proposedCheckIn: q.proposedCheckIn, proposedCheckOut: q.proposedCheckOut, consentText: q.consentText,
              language: input.language } } },
        privateConfirmation: { ...prepared.privateConfirmation, expiresAt },
      };
    },
    async confirm(input: { guestToken: string; proposalId: string; confirmationToken: string }): Promise<PinAIActionBrokerExecuteResult> {
      const reservation = await scope(input.guestToken);
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.proposalId) || typeof input.confirmationToken !== "string" ||
          !input.confirmationToken || input.confirmationToken.length > 512) reject("INVALID_STAY_TIME_REQUEST");
      const proposal = await deps.client.pinAIActionProposal.findFirst({
        where: { id: input.proposalId, reservationId: reservation.id, propertyId: reservation.propertyId,
          organizationId: reservation.property.organizationId, actionType: "RESERVATION_MODIFICATION" },
        select: { id: true, expiresAt: true, termsSnapshot: true },
      });
      if (!proposal || actionModificationRequestId(proposal) !== `stay-time:${proposal.id}`) reject("STAY_TIME_PROPOSAL_NOT_FOUND");
      // No consent/staging writes if the transport has no execution composition.
      if (!deps.execution) reject("STAY_TIME_CHAT_EXECUTION_UNAVAILABLE");
      const execution = await deps.execution();
      const execute = deps.execute ?? (await import("../../services/stay-time-guest-action.service.js")).confirmAndExecuteStayTimeGuestAction;
      const result = await execute(input,
        { ...execution, client: deps.client, now: deps.now, platformFeePercent: deps.platformFeePercent });
      const terms = proposal.termsSnapshot as { pricing: { additionalChargeMinor: number; currency: string } };
      return { ok: true, actionType: "RESERVATION_MODIFICATION", proposalId: proposal.id,
        outcome: result.outcome === "APPLIED" ? "EXECUTED" : "WAITING_FOR_PAYMENT",
        actionExecuted: result.actionExecuted, quoteExpiresAt: proposal.expiresAt,
        quoteExpiresAtLocal: formatInTimeZone(proposal.expiresAt, reservation.property.timezone!, "yyyy-MM-dd'T'HH:mm:ssXXX"),
        propertyTimezone: reservation.property.timezone!, availabilityHeld: false,
        modificationId: result.modificationId,
        modificationStatus: result.outcome === "APPLIED" ? "APPLIED" : result.outcome === "CHECKOUT_READY" ? "AWAITING_PAYMENT" : "PAYMENT_PROCESSING",
        checkoutUrl: result.checkoutUrl,
        paymentExpiresAt: "paymentExpiresAt" in result && result.paymentExpiresAt ? new Date(result.paymentExpiresAt) : null,
        amountDifference: terms.pricing.additionalChargeMinor / 100, amountDifferenceCents: terms.pricing.additionalChargeMinor,
        currency: terms.pricing.currency, reasonCode: null };
    },
  };
}

/** No provider imports until a scoped guest explicitly confirms an offer. */
export function createDefaultStayTimeChatActions(client: PrismaClient, env: NodeJS.ProcessEnv, now = () => new Date()) {
  const platformFeePercent = env.PINGO_DIRECT_BOOKING_PLATFORM_FEE_PERCENT ?? "0";
  return createStayTimeChatActions({ client, env, now, platformFeePercent,
    execution: async () => ({ client, now, platformFeePercent,
      reconcile: async reservationId => {
        const { reconcileReservation } = await import("../../services/reservation.reconcile.service.js");
        return reconcileReservation(reservationId);
      },
      createCheckout: async input => {
        const key = env.STRIPE_SECRET_KEY?.trim() ?? "";
        if (!/^(?:sk|rk)_(?:test|live)_/.test(key) || key !== process.env.STRIPE_SECRET_KEY?.trim()) reject("STAY_TIME_CHAT_EXECUTION_UNAVAILABLE");
        const { default: stripe } = await import("../../billing/stripe.js");
        const { createStayTimeCheckout } = await import("../../services/stay-time-checkout.service.js");
        const { assertDirectBookingPayoutReady } = await import("../../services/stripe-connect.service.js");
        return createStayTimeCheckout(input, { client, now, stripe,
          livemode: /^(?:sk|rk)_live_/.test(key), appUrl: env.APP_URL ?? "",
          assertPayoutReady: assertDirectBookingPayoutReady });
      },
    }),
  });
}
