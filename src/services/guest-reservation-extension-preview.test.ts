import { estimateCanonicalInStayExtension } from "../pin-ai/runtime/canonical-extension-estimate.js";
import assert from "node:assert/strict";
import test from "node:test";
import { PinAIActionProposalRuntimeToolExecutor } from "../pin-ai/runtime/action-proposal-tool-executor.js";
import { createConversationMemory } from "../pin-ai/runtime/conversation-memory.js";
import { PinAIReservationModificationActionAdapter, type PinAIReservationModificationActionAdapterDependencies } from "../pin-ai/actions/reservation-modification-action-adapter.service.js";
import { PinAIActionBroker, type PinAIActionBrokerPrisma } from "../pin-ai/actions/action-broker.service.js";

import {
  confirmGuestReservationModification,
  getGuestReservationModificationOptions,
  getGuestReservationModificationPreview,
} from "./guest-reservation-modification.service.js";

function fixture() {
  const reservation = {
    id: "reservation-canary-12345678", propertyId: "property-1", reservationNumber: "PG-TEST",
    guestEmail: "guest@example.test", preferredLanguage: "es",
    status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: null,
    checkIn: new Date("2026-09-26T18:17:03.123Z"), checkOut: new Date("2026-09-27T15:00:00Z"),
    updatedAt: new Date("2026-09-26T18:00:00Z"), adults: 2, children: 0,
    selectedAmenityIds: ["breakfast"], currency: "usd", totalAmount: 335,
    verificationGuestCount: null, verificationAcceptedRulesAt: null,
    guestAgreementAcceptance: null, guestAgreementSignedAt: null, cancellationPolicySnapshot: null,
    pricingBreakdown: {
      currency: "usd", nights: 1, nightlyRate: 250,
      nightlyRates: [{ date: "2026-09-26", rate: 250 }], nightlySubtotal: 250,
      cleaningFee: 50, amenitiesTotal: 10, taxesTotal: 25, taxableSubtotal: 310,
      amenities: [{ id: "breakfast", amount: 10, feeType: "PER_NIGHT", chargeMode: "OPTIONAL" }],
      chargedAmenities: [{ id: "breakfast", amount: 10 }], taxes: [{ id: "tax", percentage: 8, amount: 25 }],
      totalAmount: 335, totalAmountCents: 33500,
    },
    property: {
      name: "Test Property", status: "ACTIVE", isPublicBookable: true, maxGuests: 4,
      timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00",
      minimumNights: 3, maximumNights: 30,
      amenities: [{ id: "breakfast", name: "Breakfast", description: null, feeType: "PER_NIGHT", amount: 10 }],
    },
  };
  const calls: { availability: unknown[]; pricing: unknown[]; reads: unknown[] } = { availability: [], pricing: [], reads: [] };
  type Dependencies = NonNullable<Parameters<typeof getGuestReservationModificationPreview>[1]>;
  const dependencies: Dependencies = {
    client: { reservation: { findFirst: async (args: unknown) => { calls.reads.push(args); return reservation; } } } as unknown as Dependencies["client"],
    now: () => new Date("2026-09-26T22:00:00Z"),
    env: { PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true", PIN_AI_ACTION_CANARY_RESERVATION_IDS: reservation.id },
    checkAvailability: async (args) => { calls.availability.push(args); return { available: true, conflict: null }; },
    calculatePricing: async (args) => {
      calls.pricing.push(args);
      return {
        currency: "usd", nights: 1, nightlyRate: 100, nightlyRates: [{ date: "2026-09-27", rate: 100 }],
        nightlySubtotal: 100, cleaningFee: 999, // must not be billed again
        amenities: [{ id: "breakfast", name: "Breakfast", chargeMode: "OPTIONAL", feeType: "PER_NIGHT", baseAmount: 10, amount: 10, isSelected: true }],
        chargedAmenities: [], amenitiesTotal: 10, taxableSubtotal: 1109,
        taxes: [{ id: "tax", name: "Tax", percentage: 10, amount: 110.9 }], taxesTotal: 110.9,
        totalAmount: 1219.9, totalAmountCents: 121990, auditEntries: [],
      } as unknown as Awaited<ReturnType<Dependencies["calculatePricing"]>>;
    },
  };
  const input = {
    guestToken: "test-token-not-a-real-credential", operation: "EXTEND_CHECKOUT_ONLY" as const,
    checkIn: reservation.checkIn, checkOut: new Date("2026-09-28T15:00:00Z"),
    adults: 2, children: 0, selectedAmenityIds: ["breakfast"],
  };
  return { reservation, calls, dependencies, input };
}

function code(expected: string) {
  return (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === expected);
}

test("canonical preview reads only the added interval and retains original price components", async () => {
  const { input, dependencies, calls, reservation } = fixture();
  const before = JSON.stringify(reservation);
  const result = await getGuestReservationModificationPreview(input, dependencies);
  assert.equal(result.managementPhase, "IN_STAY");
  assert.equal(result.pricing.amountDifferenceCents, 12100);
  assert.equal(result.pricing.proposed.totalAmountCents, 45600);
  assert.equal(result.pricing.proposed.nightlySubtotal, 350);
  assert.equal(result.pricing.proposed.cleaningFee, 50);
  assert.equal(result.pricing.proposed.amenitiesTotal, 20);
  assert.equal(result.pricing.proposed.taxesTotal, 36);
  assert.equal(result.reservation.proposed.checkIn.getTime(), reservation.checkIn.getTime());
  assert.equal(result.changes.guestsChanged, false);
  assert.equal(result.changes.amenitiesChanged, false);
  assert.equal(calls.availability.length, 1);
  assert.deepEqual(calls.availability[0], { propertyId: reservation.propertyId, checkIn: reservation.checkOut, checkOut: input.checkOut, excludeReservationId: reservation.id });
  assert.equal(calls.pricing.length, 1);
  assert.deepEqual(calls.pricing[0], {
    propertyId: reservation.propertyId, checkIn: new Date("2026-09-27T00:00:00Z"), checkOut: new Date("2026-09-28T00:00:00Z"),
    selectedAmenityIds: ["breakfast"], excludeReservationId: reservation.id, includeAuditEntries: false,
  });
  assert.equal(result.pricing.proposed.extensionQuotes.length, 1);
  assert.equal(JSON.stringify(reservation), before);
});

test("fingerprint is stable but changes with additional night price", async () => {
  const { input, dependencies } = fixture();
  const a = await getGuestReservationModificationPreview(input, dependencies);
  const b = await getGuestReservationModificationPreview(input, dependencies);
  assert.equal(a.previewFingerprint, b.previewFingerprint);
  const calculate = dependencies.calculatePricing;
  dependencies.calculatePricing = async (args) => ({ ...await calculate(args), nightlyRates: [{ date: "2026-09-27", rate: 120 }] } as Awaited<ReturnType<typeof calculate>>);
  const c = await getGuestReservationModificationPreview(input, dependencies);
  assert.notEqual(c.previewFingerprint, a.previewFingerprint);
});

for (const flags of [
  { PIN_AI_ACTION_CANARY_RESERVATION_IDS: "another-reservation-12345" },
  { PIN_AI_ACTION_CANARY_RESERVATION_IDS: "" },
  { PIN_AI_ACTION_BROKER_ENABLED: "false" },
  { PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "false" },
]) {
  test(`extension is closed outside the enabled canary: ${JSON.stringify(flags)}`, async () => {
    const { input, dependencies, calls } = fixture();
    dependencies.env = { ...dependencies.env, ...flags };
    await assert.rejects(getGuestReservationModificationPreview(input, dependencies), code("RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION"));
    assert.equal(calls.pricing.length, 0);
  });
}

test("ordinary modification calls retain the original IN_STAY rejection", async () => {
  const { input, dependencies } = fixture();
  const { operation: _, ...ordinary } = input;
  await assert.rejects(getGuestReservationModificationPreview(ordinary, dependencies), code("RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION"));
  await assert.rejects(getGuestReservationModificationOptions({ guestToken: input.guestToken }, dependencies), code("RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION"));
  const options = await getGuestReservationModificationOptions({ guestToken: input.guestToken, allowInStayExtension: true }, dependencies);
  assert.equal(options.managementPhase, "IN_STAY");
  assert.equal(options.constraints.guestCountEditable, false);
});

test("fails before quoting if check-in, guests or selected amenities change", async () => {
  for (const change of [
    { checkIn: new Date("2026-09-26T20:00:00Z") }, { adults: 3 }, { selectedAmenityIds: [] },
  ]) {
    const { input, dependencies, calls } = fixture();
    await assert.rejects(getGuestReservationModificationPreview({ ...input, ...change }, dependencies), code("EXTENSION_MUST_PRESERVE_CURRENT_STAY"));
    assert.equal(calls.pricing.length, 0);
  }
});

test("fails closed for incomplete historical price breakdown", async () => {
  const { input, dependencies, reservation, calls } = fixture();
  reservation.pricingBreakdown.totalAmount = 999;
  await assert.rejects(getGuestReservationModificationPreview(input, dependencies), code("EXTENSION_PRICING_SNAPSHOT_MISMATCH"));
  assert.equal(calls.pricing.length, 0);
});

test("availability conflicts prevent quoting the extension", async () => {
  const { input, dependencies, calls } = fixture();
  dependencies.checkAvailability = async () => ({ available: false, conflict: { type: "RESERVATION" } } as Awaited<ReturnType<typeof dependencies.checkAvailability>>);
  await assert.rejects(getGuestReservationModificationPreview(input, dependencies), code("PROPERTY_NOT_AVAILABLE_FOR_SELECTED_DATES"));
  assert.equal(calls.pricing.length, 0);
});

test("successive previews preserve the accumulated historical price and extension audit", async () => {
  const { input, dependencies, reservation } = fixture();
  const first = await getGuestReservationModificationPreview(input, dependencies);
  reservation.checkOut = input.checkOut;
  reservation.totalAmount = first.pricing.proposed.totalAmount;
  reservation.pricingBreakdown = first.pricing.proposed;
  dependencies.now = () => new Date("2026-09-28T14:00:00Z");
  const calculate = dependencies.calculatePricing;
  dependencies.calculatePricing = async (args) => ({ ...await calculate(args), nightlyRates: [{ date: "2026-09-28", rate: 100 }] } as Awaited<ReturnType<typeof calculate>>);
  const next = await getGuestReservationModificationPreview({ ...input, checkOut: new Date("2026-09-29T15:00:00Z") }, dependencies);
  assert.equal(next.pricing.amountDifferenceCents, 12100);
  assert.equal(next.pricing.proposed.totalAmountCents, 57700);
  assert.equal(next.pricing.proposed.cleaningFee, 50);
  assert.equal(next.pricing.proposed.extensionQuotes.length, 2);
  assert.deepEqual(next.pricing.proposed.nightlyRates.map((item: { date: string }) => item.date), ["2026-09-26", "2026-09-27", "2026-09-28"]);
});

test("rejects a historical breakdown with the right total but the wrong nightly dates", async () => {
  const { input, dependencies, reservation } = fixture();
  reservation.pricingBreakdown.nightlyRates[0]!.date = "2026-09-27";
  await assert.rejects(getGuestReservationModificationPreview(input, dependencies), code("EXTENSION_PRICING_SNAPSHOT_MISMATCH"));
});

test("PRE_STAY retains full-stay pricing and its original minimum-night validation", async () => {
  const { input, dependencies, reservation, calls } = fixture();
  dependencies.now = () => new Date("2026-09-25T12:00:00Z");
  reservation.property.minimumNights = 1;
  const { operation: _, ...ordinary } = input;
  const result = await getGuestReservationModificationPreview(ordinary, dependencies);
  assert.equal(result.managementPhase, "PRE_STAY");
  assert.equal(result.pricing.proposed.totalAmountCents, 121990);
  assert.equal(result.pricing.amountDifferenceCents, 88490);
  assert.equal((calls.pricing[0] as { checkIn: Date }).checkIn.getTime(), reservation.checkIn.getTime());
  reservation.property.minimumNights = 3;
  await assert.rejects(getGuestReservationModificationPreview(ordinary, dependencies), code("MINIMUM_STAY_NOT_MET"));
});

test("extension confirmation rejects requests without confirmed Pin AI evidence", async () => {
  const { input } = fixture();
  await assert.rejects(confirmGuestReservationModification({ ...input, clientRequestId: "test-confirmation-12345" }), code("PIN_AI_ACTION_PROPOSAL_EVIDENCE_REQUIRED"));
});

for (const selected of [true, false]) {
  test(`runtime → broker → adapter → canonical preview: canary selected=${selected}`, async () => {
    const { reservation, dependencies, input, calls } = fixture();
    if (!selected) dependencies.env.PIN_AI_ACTION_CANARY_RESERVATION_IDS = "other-reservation-12345678";
    const before = JSON.stringify(reservation);
    const proposals: Parameters<PinAIReservationModificationActionAdapterDependencies["createProposal"]>[0][] = [];
    const forbidden = async (): Promise<never> => { throw new Error("Unexpected operational call in preparation"); };
    const prisma = {
      reservation: { findFirst: forbidden },
      pinAIActionProposal: { findFirst: forbidden },
    } as unknown as PinAIActionBrokerPrisma;
    const adapter = new PinAIReservationModificationActionAdapter({
      prisma, now: dependencies.now,
      getPreview: (args) => getGuestReservationModificationPreview(args, dependencies),
      createProposal: async (args) => {
        proposals.push(args);
        return { confirmationToken: "private-test-confirmation-token", proposal: { id: "proposal-test-12345678", expiresAt: args.expiresAt } };
      },
      supersedeProposal: forbidden, confirmModification: forbidden,
      createCheckout: forbidden, applyModification: forbidden,
    });
    const broker = new PinAIActionBroker({ prisma, reservationModification: adapter, now: dependencies.now, confirmProposal: forbidden });
    const executor = new PinAIActionProposalRuntimeToolExecutor({
      enabled: true, guestToken: input.guestToken,
      delegate: { execute: forbidden },
      getModificationOptions: (args) => getGuestReservationModificationOptions(args, dependencies),
      prepareReservationModification: (args) => broker.prepareReservationModification(args),
    });
    const request = {
      context: { organizationId: "org-test", propertyId: reservation.propertyId, reservationId: reservation.id,
        guestId: "guest-test", currentLocalDateTime: "2026-09-26T18:00:00-04:00", preferredLanguage: "es" as const },
      conversation: [{ role: "guest" as const, content: "Quiero extender mi salida al 28 de septiembre." }],
    };
    const run = () => executor.execute("prepare_reservation_modification", {
      operation: "EXTEND_CHECKOUT_ONLY", proposedCheckOutDate: "2026-09-28",
    }, request, createConversationMemory(request));
    if (!selected) {
      await assert.rejects(run(), code("RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION"));
      assert.equal(proposals.length, 0);
      assert.equal(calls.pricing.length, 0);
      return;
    }
    const result = await run();
    assert.equal(result.decision, "ACTION_PROPOSAL_PREPARED");
    assert.equal(result.actionExecuted, false);
    assert.equal(proposals.length, 1);
    const terms = proposals[0].termsSnapshot;
    assert.equal(terms.operation, "EXTEND_CHECKOUT_ONLY");
    assert.equal((terms.proposed as { checkIn: string }).checkIn, reservation.checkIn.toISOString());
    assert.equal(executor.getPrivateActionProposal()?.publicResult.quote.amountDifferenceCents, 12100);
    assert.equal(JSON.stringify(result).includes("private-test-confirmation-token"), false);
    assert.equal(JSON.stringify(reservation), before);
    assert.deepEqual(calls.availability[0], { propertyId: reservation.propertyId, checkIn: reservation.checkOut, checkOut: input.checkOut, excludeReservationId: reservation.id });
    await run();
    assert.equal(proposals.length, 1);
  });
}


async function confirmationFixture() {
  const f = fixture();
  const preview = await getGuestReservationModificationPreview(f.input, f.dependencies);
  type Dependencies = NonNullable<Parameters<typeof confirmGuestReservationModification>[1]>;
  let stored: any = null;
  let creates = 0;
  let locked = false;
  let active: unknown = null;
  let lockedReservation = f.reservation;
  const tx = {
    $queryRaw: async () => { locked = true; return []; },
    reservation: { findUnique: async () => { assert.equal(locked, true); return lockedReservation; } },
    reservationModification: {
      findUnique: async () => stored,
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => active,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        assert.equal(locked, true);
        creates += 1;
        stored = { ...data, id: "modification-test-12345", createdAt: f.dependencies.now(), appliedAt: null,
          stripeCheckoutSessionId: null, stripeConnectedAccountId: null, stripePaymentStatus: null };
        return stored;
      },
    },
  };
  const dependencies: Dependencies = {
    ...f.dependencies,
    client: {
      reservation: f.dependencies.client.reservation,
      reservationModification: { findFirst: async () => stored },
      $transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as Dependencies["client"],
  };
  const input = { ...f.input, clientRequestId: "confirm-test-12345678", confirmationSource: "PIN_AI_GUEST_SERVICES" as const,
    expectedPreviewFingerprint: preview.previewFingerprint, actionProposalId: "proposal-test-12345678",
    actionProposalFingerprint: "b".repeat(64), actionProposalConfirmedAt: f.dependencies.now() };
  return { ...f, preview, confirmationDependencies: dependencies, confirmationInput: input,
    getStored: () => stored, getCreates: () => creates,
    setActive: (value: unknown) => { active = value; },
    setLockedReservation: (value: typeof f.reservation) => { lockedReservation = value; },
  };
}

test("canonical confirmation records a checkout-only extension once without modifying the reservation", async () => {
  const f = await confirmationFixture();
  const before = JSON.stringify(f.reservation);
  const result = await confirmGuestReservationModification(f.confirmationInput, f.confirmationDependencies);
  assert.equal(result.modification.status, "AWAITING_PAYMENT");
  assert.equal(result.modification.additionalChargeAmount, 121);
  const stored = f.getStored();
  assert.equal(stored.guestConfirmation.operation, "EXTEND_CHECKOUT_ONLY");
  assert.equal(stored.proposedCheckIn.toISOString(), f.reservation.checkIn.toISOString());
  assert.equal(stored.proposedPricing.cleaningFee, 50);
  assert.equal(stored.guestConfirmation.confirmedPreviewFingerprint, f.preview.previewFingerprint);
  const replay = await confirmGuestReservationModification(f.confirmationInput, f.confirmationDependencies);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(f.getCreates(), 1);
  assert.equal(JSON.stringify(f.reservation), before);
  await assert.rejects(confirmGuestReservationModification({ ...f.confirmationInput, checkOut: new Date("2026-09-29T15:00:00Z") }, f.confirmationDependencies), code("CLIENT_REQUEST_ID_REUSED"));
});

for (const scenario of ["changed price", "outside canary", "concurrent update", "active modification", "near checkout", "missing evidence"] as const) {
  test(`confirmation rejects ${scenario} without creating a modification`, async () => {
    const f = await confirmationFixture();
    let expected: string;
    if (scenario === "changed price") {
      f.confirmationInput.expectedPreviewFingerprint = "c".repeat(64);
      expected = "RESERVATION_MODIFICATION_PREVIEW_CHANGED";
    } else if (scenario === "outside canary") {
      f.confirmationDependencies.env = { ...f.dependencies.env, PIN_AI_ACTION_CANARY_RESERVATION_IDS: "other-reservation-12345678" };
      expected = "RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION";
    } else if (scenario === "concurrent update") {
      f.setLockedReservation({ ...f.reservation, totalAmount: 336, updatedAt: new Date("2026-09-26T22:01:00Z") });
      expected = "RESERVATION_CHANGED_RETRY_PREVIEW";
    } else if (scenario === "active modification") {
      f.setActive({ id: "other-modification", status: "AWAITING_PAYMENT" });
      expected = "ACTIVE_RESERVATION_MODIFICATION_EXISTS";
    } else if (scenario === "near checkout") {
      f.confirmationDependencies.now = () => new Date("2026-09-27T14:31:00Z");
      expected = "RESERVATION_MODIFICATION_CHECKOUT_WINDOW_EXPIRED";
    } else {
      f.confirmationInput.actionProposalFingerprint = "";
      expected = "PIN_AI_ACTION_PROPOSAL_EVIDENCE_REQUIRED";
    }
    await assert.rejects(confirmGuestReservationModification(f.confirmationInput, f.confirmationDependencies), code(expected));
    assert.equal(f.getCreates(), 0);
  });
}

test("confirmation caps the payment window at original checkout", async () => {
  const f = await confirmationFixture();
  f.confirmationDependencies.now = () => new Date("2026-09-27T14:15:00Z");
  const result = await confirmGuestReservationModification(f.confirmationInput, f.confirmationDependencies);
  assert.equal(result.modification.checkoutExpiresAt.toISOString(), f.reservation.checkOut.toISOString());
});

test("watchdog timestamps may advance after quotation and again under the confirmation lock", async () => {
  const f = await confirmationFixture();
  f.reservation.updatedAt = new Date("2026-09-26T22:01:00Z");
  f.setLockedReservation({ ...f.reservation, updatedAt: new Date("2026-09-26T22:02:00Z") });
  const result = await confirmGuestReservationModification(f.confirmationInput, f.confirmationDependencies);
  assert.equal(result.modification.status, "AWAITING_PAYMENT");
  assert.equal(f.getCreates(), 1);
});

async function checkoutFixture() {
  process.env.STRIPE_SECRET_KEY ??= "sk_test_contract_only";
  const { createGuestReservationModificationCheckout } = await import("./guest-reservation-modification-checkout.service.js");
  const f = await confirmationFixture();
  await confirmGuestReservationModification(f.confirmationInput, f.confirmationDependencies);
  const modification = f.getStored();
  modification.reservation = {
    ...f.reservation, guestEmail: "guest@example.test", preferredLanguage: "es",
    property: { ...f.reservation.property, id: f.reservation.propertyId, organizationId: "org-test" },
  };
  const providerCalls: Array<{ params: any; options: any }> = [];
  type Dependencies = NonNullable<Parameters<typeof createGuestReservationModificationCheckout>[1]>;
  const session = { id: "cs_test_extension", status: "open", payment_status: "unpaid", url: "https://checkout.example.test/extension",
    expires_at: modification.checkoutExpiresAt.getTime() / 1000, metadata: { reservationModificationId: modification.id } };
  const dependencies: Dependencies = {
    client: { reservationModification: {
      findFirst: async () => modification,
      findUniqueOrThrow: async () => modification,
      updateMany: async ({ data }: { data: object }) => { Object.assign(modification, data); return { count: 1 }; },
    } } as unknown as Dependencies["client"],
    stripe: { checkout: { sessions: {
      create: async (params: unknown, options: unknown) => { providerCalls.push({ params, options }); return session; },
      retrieve: async () => session,
    } } } as unknown as Dependencies["stripe"],
    now: f.dependencies.now, checkAvailability: f.dependencies.checkAvailability, calculatePricing: f.dependencies.calculatePricing,
    assertPayoutReady: async () => ({ connectedAccountId: "acct_test_host", payoutStatus: {} } as Awaited<ReturnType<Dependencies["assertPayoutReady"]>>),
  };
  f.calls.availability.length = 0;
  f.calls.pricing.length = 0;
  const run = () => createGuestReservationModificationCheckout({ guestToken: f.input.guestToken, modificationId: modification.id }, dependencies);
  return { ...f, modification, checkoutDependencies: dependencies, providerCalls, run };
}

test("confirmed extension checkout requotes only added nights and sends only the incremental amount to a fake provider", async () => {
  const f = await checkoutFixture();
  f.modification.reservation.updatedAt = new Date("2026-09-26T22:01:00Z");
  f.modification.reservation.lastReconciledAt = new Date("2026-09-26T22:01:00Z");
  const result = await f.run();
  assert.equal(result.idempotentReplay, false);
  assert.equal(f.providerCalls.length, 1);
  assert.equal(f.providerCalls[0].params.line_items[0].price_data.unit_amount, 12100);
  assert.equal(f.providerCalls[0].options.stripeAccount, "acct_test_host");
  assert.equal(f.providerCalls[0].options.idempotencyKey, `direct-booking-reservation-modification-checkout:${f.modification.id}`);
  assert.deepEqual(f.calls.availability[0], {
    propertyId: f.reservation.propertyId, checkIn: f.reservation.checkOut, checkOut: f.input.checkOut,
    excludeReservationId: f.reservation.id, excludeReservationModificationId: f.modification.id,
  });
  assert.equal((f.calls.pricing[0] as { checkIn: Date }).checkIn.toISOString(), "2026-09-27T00:00:00.000Z");
  assert.equal(f.modification.reservation.checkIn.getTime(), f.reservation.checkIn.getTime());
  const replay = await f.run();
  assert.equal(replay.idempotentReplay, true);
  assert.equal(f.providerCalls.length, 1);
});

for (const scenario of ["price changed", "availability conflict", "missing evidence", "expired original stay", "changed reservation", "short payment window"] as const) {
  test(`checkout blocks ${scenario} before calling the provider`, async () => {
    const f = await checkoutFixture();
    let expected: string;
    if (scenario === "price changed") {
      const calculate = f.checkoutDependencies.calculatePricing;
      f.checkoutDependencies.calculatePricing = async (args) => ({ ...await calculate(args), nightlyRates: [{ date: "2026-09-27", rate: 130 }] } as Awaited<ReturnType<typeof calculate>>);
      expected = "RESERVATION_MODIFICATION_PRICE_CHANGED";
    } else if (scenario === "availability conflict") {
      f.checkoutDependencies.checkAvailability = async () => ({ available: false, conflict: { type: "RESERVATION" } } as Awaited<ReturnType<typeof f.dependencies.checkAvailability>>);
      expected = "PROPERTY_NOT_AVAILABLE_FOR_SELECTED_DATES";
    } else if (scenario === "missing evidence") {
      delete f.modification.guestConfirmation.actionProposalId;
      expected = "EXTENSION_CONFIRMED_PROPOSAL_REQUIRED";
    } else if (scenario === "expired original stay") {
      f.checkoutDependencies.now = () => f.reservation.checkOut;
      expected = "EXTENSION_STAY_WINDOW_CHANGED";
    } else if (scenario === "changed reservation") {
      f.modification.reservation.updatedAt = new Date("2026-09-26T22:01:00Z");
      f.modification.reservation.totalAmount = 336;
      expected = "RESERVATION_CHANGED_RETRY_PREVIEW";
    } else {
      f.modification.checkoutExpiresAt = new Date(f.dependencies.now().getTime() + 29 * 60 * 1000);
      expected = "RESERVATION_MODIFICATION_CHECKOUT_WINDOW_EXPIRED";
    }
    await assert.rejects(f.run(), code(expected));
    assert.equal(f.providerCalls.length, 0);
  });
}


test("canary read estimate uses exactly the proposal canonical quote without operational writes", async () => {
  const { input, dependencies, reservation, calls } = fixture();
  const before = JSON.stringify(reservation);
  const estimate = await estimateCanonicalInStayExtension(input.guestToken, { additionalNights: 1 }, {
    getOptions: args => getGuestReservationModificationOptions(args, dependencies),
    preview: args => getGuestReservationModificationPreview(args, dependencies),
  });
  assert.equal(estimate?.decision, "PRICE_CALCULATED_FOR_REVIEW");
  assert.equal(calls.pricing.length, 1);
  assert.equal((calls.pricing[0] as {checkIn: Date}).checkIn.toISOString(), "2026-09-27T00:00:00.000Z");
  const proposalPreview = await getGuestReservationModificationPreview(input, dependencies);
  assert.equal(estimate?.additionalAmountCents, proposalPreview.pricing.amountDifferenceCents);
  assert.equal(estimate?.proposedReservationTotalCents, proposalPreview.pricing.proposed.totalAmountCents);
  assert.equal(estimate?.currentReservationTotalCents, 33500);
  assert.equal(estimate?.additionalAmountCents, 12100);
  assert.equal(estimate?.proposalCreated, false);
  assert.equal(estimate?.chargeExecuted, false);
  assert.equal(estimate?.reservationChanged, false);
  assert.equal(estimate?.availabilityHeld, false);
  assert.equal(JSON.stringify(reservation), before);
});

test("canonical estimate preserves PRE_STAY delegation and rejects invalid inputs before reads", async () => {
  const { input, dependencies, calls } = fixture();
  const providers = {
    getOptions: (args: Parameters<typeof getGuestReservationModificationOptions>[0]) => getGuestReservationModificationOptions(args, dependencies),
    preview: (args: Parameters<typeof getGuestReservationModificationPreview>[0]) => getGuestReservationModificationPreview(args, dependencies),
  };
  for (const additionalNights of [0, -1, 31, 1.5, "1", undefined]) {
    const result = await estimateCanonicalInStayExtension(input.guestToken, { additionalNights }, providers);
    assert.equal(result?.priceCalculated, false);
  }
  assert.equal(calls.reads.length, 0);
  dependencies.now = () => new Date("2026-09-25T12:00:00Z");
  assert.equal(await estimateCanonicalInStayExtension(input.guestToken, { additionalNights: 1 }, providers), null);
  assert.equal(calls.pricing.length, 0);
});

for (const failure of ["availability", "snapshot", "canary"] as const) {
  test(`canonical estimate requires review without alternate repricing on ${failure} rejection`, async () => {
    const { input, dependencies, reservation, calls } = fixture();
    if (failure === "availability") dependencies.checkAvailability = async () => ({ available: false, conflict: null });
    if (failure === "snapshot") reservation.pricingBreakdown.totalAmount = 999;
    if (failure === "canary") dependencies.env.PIN_AI_ACTION_CANARY_RESERVATION_IDS = "another-reservation";
    const result = await estimateCanonicalInStayExtension(input.guestToken, { additionalNights: 1 }, {
      getOptions: args => getGuestReservationModificationOptions(args, dependencies),
      preview: args => getGuestReservationModificationPreview(args, dependencies),
    });
    assert.equal(result?.decision, "PRICE_REQUIRES_HUMAN_REVIEW");
    assert.equal(result?.priceCalculated, false);
    assert.equal(result?.additionalAmountCents, undefined);
    assert.equal(calls.pricing.length, 0);
  });
}
