import assert from "node:assert/strict";
import test from "node:test";
import { createStayTimeChatActions, stayTimeChatEnabled, actionModificationRequestId } from "./stay-time-chat-actions.js";
import { PinAIActionProposalRuntimeToolExecutor } from "../runtime/action-proposal-tool-executor.js";
import { createConversationMemory } from "../runtime/conversation-memory.js";
import { buildPinAIOpenAITools, buildPinAIOpenAIInstructions } from "../runtime/openai-agent-config.js";
import type { PinAIRuntimeRequest } from "../runtime/contracts.js";

const guestToken = "guest-token-1234567890";
const scope = { organizationId: "organization-a", propertyId: "property-a", reservationId: "reservation-a" };
const now = new Date("2026-10-03T12:00:00Z"), expiresAt = new Date("2026-10-03T12:01:00Z");
const env = { PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true",
  PIN_AI_ACTION_CANARY_RESERVATION_IDS: scope.reservationId, PIN_AI_STAY_TIME_CHAT_ENABLED: "true" };
const request: PinAIRuntimeRequest = { context: { ...scope, guestId: "guest-a", preferredLanguage: "es",
  currentLocalDateTime: "2026-10-03T08:00:00-04:00" }, conversation: [{ role: "guest", content: "Quiero salir a las 12:00" }] };
function harness(options: { enabled?: boolean; missing?: boolean; foreign?: boolean; paid?: boolean; pending?: boolean; execution?: boolean } = {}) {
  const calls: string[] = [];
  const pricing = { additionalChargeMinor: options.paid ? 1120 : 0, currency: "USD" };
  const client = {
    reservation: { findFirst: async (args: any) => {
      calls.push("scope"); assert.equal(args.where.guestToken, guestToken); assert.deepEqual(args.where.guestTokenExpiresAt, { gt: now });
      return options.missing ? null : { id: options.foreign ? "reservation-foreign" : scope.reservationId,
        propertyId: scope.propertyId, property: { organizationId: scope.organizationId, timezone: "America/Puerto_Rico" } };
    } },
    pinAIActionProposal: { findFirst: async (args: any) => {
      calls.push("proposal"); assert.equal(args.where.reservationId, scope.reservationId);
      assert.equal(args.where.organizationId, scope.organizationId); assert.equal(args.where.propertyId, scope.propertyId);
      return { id: "proposal-12345678", expiresAt, termsSnapshot: { version: "stay_time_quote_v1", pricing } };
    } },
  };
  const actions = createStayTimeChatActions({ client: client as never,
    env: options.enabled === false ? { ...env, PIN_AI_STAY_TIME_CHAT_ENABLED: "false" } : env,
    now: () => now, platformFeePercent: "0",
    prepare: async (_db, input) => {
      calls.push("prepare"); assert.equal(input.guestToken, guestToken); assert.equal(input.language, "es");
      return { publicResult: { proposalId: "proposal-12345678", operation: input.operation, requiresGuestConfirmation: true,
        actionExecuted: false, reservationChanged: false, availabilityHeld: false,
        quote: { requestedLocalTime: input.requestedLocalTime, currentCheckIn: "2026-10-02T20:00:00Z",
          currentCheckOut: "2026-10-03T15:00:00Z", proposedCheckIn: "2026-10-02T20:00:00Z", proposedCheckOut: "2026-10-03T16:00:00Z",
          currentTotalMinor: 20000, proposedTotalMinor: 20000 + pricing.additionalChargeMinor, ...pricing,
          expiresAt: expiresAt.toISOString(), consentText: "Confirmo la salida a las 12:00, impuestos incluidos." } },
        privateConfirmation: { proposalId: "proposal-12345678", confirmationToken: "secret-not-for-model", expiresAt: expiresAt.toISOString() } };
    },
    ...(options.execution === false ? {} : { execution: async () => {
      calls.push("composition"); return { client: client as never, now: () => now, platformFeePercent: "0", reconcile: async () => {} };
    } }),
    execute: async (input) => {
      calls.push("execute"); assert.equal(input.confirmationToken, "secret-not-for-model");
      return options.paid ? { outcome: options.pending ? "PAYMENT_PENDING" : "CHECKOUT_READY", proposalId: input.proposalId,
        modificationId: "modification-a", actionExecuted: false, reservationChanged: false, accessReady: false,
        localHoldActive: true, checkoutUrl: options.pending ? null : "https://checkout.stripe.com/c/pay/test",
        paymentExpiresAt: "2026-10-03T12:31:00Z", idempotentReplay: false }
        : { outcome: "APPLIED", proposalId: input.proposalId, modificationId: "modification-a", actionExecuted: true,
          reservationChanged: true, checkoutUrl: null, accessReady: false, idempotentReplay: false };
    },
  });
  return { actions, calls };
}
const prepareInput = { guestToken, operation: "LATE_CHECKOUT" as const, requestedLocalTime: "12:00", language: "es" as const };
const confirmInput = { guestToken, proposalId: "proposal-12345678", confirmationToken: "secret-not-for-model" };

test("chat stays disabled unless both action flags, dedicated flag and reservation allowlist agree", () => {
  assert.equal(stayTimeChatEnabled(scope.reservationId, env), true);
  for (const flag of Object.keys(env)) assert.equal(stayTimeChatEnabled(scope.reservationId, { ...env, [flag]: "" }), false);
  assert.equal(stayTimeChatEnabled("reservation-other", env), false);
});
test("request IDs use persisted terms, preserving legacy date changes", () => {
  assert.equal(actionModificationRequestId({ id: "a", termsSnapshot: { version: "stay_time_quote_v1" } }), "stay-time:a");
  assert.equal(actionModificationRequestId({ id: "a", termsSnapshot: {} }), "pin_ai_a");
});
for (const paid of [false, true]) test(`preparation exposes exact schedule and tax-inclusive price, paid=${paid}`, async () => {
  const { actions, calls } = harness({ paid });
  const result = await actions.prepare(prepareInput, scope);
  assert.equal(result.publicResult.quote.amountDifferenceCents, paid ? 1120 : 0);
  assert.equal(result.publicResult.quote.stayTime?.requestedLocalTime, "12:00");
  assert.equal(result.publicResult.quote.stayTime?.language, "es");
  assert.equal(result.publicResult.quote.quoteExpiresAtLocal, "2026-10-03T08:01:00-04:00");
  assert.equal(result.publicResult.actionExecuted, false);
  assert.equal(JSON.stringify(result.publicResult).includes("secret-not-for-model"), false);
  assert.deepEqual(calls, ["scope", "prepare"]);
});
for (const options of [{ enabled: false }, { missing: true }, { foreign: true }]) test(`unauthorized preparation fails before writing ${JSON.stringify(options)}`, async () => {
  const { actions, calls } = harness(options);
  await assert.rejects(actions.prepare(prepareInput, scope));
  assert.deepEqual(calls, ["scope"]);
});
test("runtime context must match token-resolved organization and property", async () => {
  const { actions, calls } = harness();
  await assert.rejects(actions.prepare(prepareInput, { ...scope, propertyId: "another-property" }));
  assert.deepEqual(calls, ["scope"]);
});
for (const options of [{}, { paid: true }, { paid: true, pending: true }]) test(`confirmation translates canonical outcome ${JSON.stringify(options)}`, async () => {
  const { actions } = harness(options);
  const result = await actions.confirm(confirmInput);
  assert.equal(result.outcome, options.paid ? "WAITING_FOR_PAYMENT" : "EXECUTED");
  assert.equal(result.actionExecuted, !options.paid);
  assert.equal(result.modificationStatus, !options.paid ? "APPLIED" : options.pending ? "PAYMENT_PROCESSING" : "AWAITING_PAYMENT");
});
test("missing execution composition fails before consent or staging", async () => {
  const { actions, calls } = harness({ execution: false });
  await assert.rejects(actions.confirm(confirmInput), /EXECUTION_UNAVAILABLE/);
  assert.deepEqual(calls, ["scope", "proposal"]);
});
test("runtime separates credential, reuses one proposal and rejects a second offer", async () => {
  const { actions, calls } = harness({ paid: true });
  const executor = new PinAIActionProposalRuntimeToolExecutor({ enabled: true, guestToken, prepareStayTime: actions.prepare,
    delegate: { execute: async () => ({ readOnly: true }) }, getModificationOptions: async () => { throw new Error("wrong operation"); },
    prepareReservationModification: async () => { throw new Error("wrong operation"); } });
  const memory = createConversationMemory(request);
  const args = { operation: "LATE_CHECKOUT", requestedLocalTime: "12:00" };
  const result = await executor.execute("prepare_reservation_modification", args, request, memory);
  assert.equal(result.authorizationGranted, false); assert.equal(result.actionExecuted, false);
  assert.equal(JSON.stringify(result).includes("secret-not-for-model"), false);
  assert.equal(executor.getPrivateActionProposal()?.privateConfirmation.confirmationToken, "secret-not-for-model");
  assert.deepEqual(await executor.execute("prepare_reservation_modification", args, request, memory), result);
  await assert.rejects(executor.execute("prepare_reservation_modification", { ...args, requestedLocalTime: "13:00" }, request, memory), /MULTIPLE_ACTION/);
  for (const extra of [{ guestToken: "attacker" }, { amount: 0 }, { proposedCheckOutDate: "2026-10-04" }, { confirmationToken: "fake" }]) {
    await assert.rejects(executor.execute("prepare_reservation_modification", { ...args, ...extra }, request, memory), /ARGUMENTS_INVALID/);
  }
  assert.deepEqual(await executor.execute("check_late_checkout", { requestedLocalTime: "12:00" }, request, memory), { readOnly: true });
  assert.deepEqual(calls, ["scope", "prepare"]);
});
test("session-only schema changes preserve default Saved Agent configuration", () => {
  const legacy = JSON.stringify(buildPinAIOpenAITools(undefined, { enabled: true }));
  assert.equal(legacy.includes('"EARLY_CHECKIN"'), false);
  const enabled = JSON.stringify(buildPinAIOpenAITools(undefined, { enabled: true, stayTimeEnabled: true }));
  assert.equal(enabled.includes('"EARLY_CHECKIN"'), true);
  assert.match(buildPinAIOpenAIInstructions({ enabled: true, stayTimeEnabled: true }), /typed yes is not consent/);
  assert.equal(JSON.stringify(buildPinAIOpenAITools()).includes("prepare_reservation_modification"), false);
});
