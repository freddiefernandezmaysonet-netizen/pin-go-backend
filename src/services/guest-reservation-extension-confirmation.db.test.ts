import { applyGuestReservationModification } from "./guest-reservation-modification-apply.service.js";
import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { confirmGuestReservationModification, getGuestReservationModificationPreview, getGuestReservationModificationOptions } from "./guest-reservation-modification.service.js";
import { PinAIReservationModificationActionAdapter } from "../pin-ai/actions/reservation-modification-action-adapter.service.js";
import { createPinAIActionProposal, confirmPinAIActionProposal, supersedePinAIActionProposal } from "../pin-ai/actions/action-proposal.service.js";
import { PinAIActionBroker } from "../pin-ai/actions/action-broker.service.js";
import { PinAIActionProposalRuntimeToolExecutor } from "../pin-ai/runtime/action-proposal-tool-executor.js";
import { createConversationMemory } from "../pin-ai/runtime/conversation-memory.js";
import { GuestPinAIGateway } from "../pin-ai/guest/guest-runtime-gateway.js";
import { createGuestReservationModificationCheckout } from "./guest-reservation-modification-checkout.service.js";

const TEST_URL = "postgresql://postgres:postgres@127.0.0.1:5432/pingo_pin_ai_extension_test";

test("in-stay confirmation concurrency in disposable PostgreSQL", async t => {
  assert.equal(process.env.PIN_AI_EXTENSION_TEST_DATABASE_URL, TEST_URL, "Refusing non-disposable database");
  assert.equal(process.env.DATABASE_URL, TEST_URL, "Default client must also target the disposable database");
  const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  t.after(() => db.$disconnect());
  assert.equal(await db.organization.count(), 0, "Use an empty database; never reset existing records");
  assert.equal(await db.reservation.count(), 0);
  assert.equal(await db.reservationModification.count(), 0);
  const now = new Date("2026-09-26T22:00:00Z");
  let sequence = 0;

  async function fixture(concurrent = true) {
    const key = `synthetic-extension-${++sequence}`;
    const org = await db.organization.create({ data: { name: key } });
    const property = await db.property.create({ data: {
      name: key, organizationId: org.id, status: "ACTIVE", isPublicBookable: true,
      timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00", minimumNights: 1,
    } });
    const reservation = await db.reservation.create({ data: {
      propertyId: property.id, guestName: "Synthetic", guestEmail: `${key}@example.invalid`, guestToken: key,
      source: "DIRECT_BOOKING", status: "ACTIVE", paymentState: "PAID", currency: "usd",
      adults: 2, children: 0, selectedAmenityIds: [], totalAmount: 150,
      amountCollected: 150, platformFeeAmount: 0, hostPayoutAmount: 150, stripeConnectedAccountId: "acct_synthetic",
      checkIn: new Date("2026-09-26T20:00:00Z"), checkOut: new Date("2026-09-27T15:00:00Z"),
      pricingBreakdown: {
        currency: "usd", nights: 1, nightlyRate: 100, nightlyRates: [{date: "2026-09-26", rate: 100}],
        nightlySubtotal: 100, cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0,
        totalAmount: 150, totalAmountCents: 15000, amenities: [], taxes: [],
      },
    } });
    type Dependencies = NonNullable<Parameters<typeof confirmGuestReservationModification>[1]>;
    const dependencies: Dependencies = {
      client: db, now: () => new Date(now),
      env: { PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true", PIN_AI_ACTION_CANARY_RESERVATION_IDS: reservation.id },
      checkAvailability: async () => ({available: true, conflict: null}),
      calculatePricing: async () => ({
        currency: "usd", nights: 1, nightlyRate: 100,
        nightlyRates: [{date: "2026-09-27", rate: 100, reason: "Synthetic", appliedRules: [], pricingBreakdown: []}],
        nightlySubtotal: 100, cleaningFee: 0, amenities: [], chargedAmenities: [], amenitiesTotal: 0,
        taxableSubtotal: 100, taxes: [], taxesTotal: 0, totalAmount: 100, totalAmountCents: 10000, auditEntries: [],
      }),
    };
    const input = {
      guestToken: key, operation: "EXTEND_CHECKOUT_ONLY" as const,
      checkIn: reservation.checkIn, checkOut: new Date("2026-09-28T15:00:00Z"),
      adults: 2, children: 0, selectedAmenityIds: [],
    };
    const preview = await getGuestReservationModificationPreview(input, dependencies);
    const confirmation = {
      ...input, clientRequestId: `${key}-request`, confirmationSource: "PIN_AI_GUEST_SERVICES" as const,
      expectedPreviewFingerprint: preview.previewFingerprint, actionProposalId: `${key}-proposal`,
      actionProposalFingerprint: "b".repeat(64), actionProposalConfirmedAt: new Date(now),
    };
    // Both requests must pass the early replay lookup before either enters its DB transaction.
    let arrivals = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>(resolve => { release = resolve; });
    dependencies.checkAvailability = async () => {
      if (!concurrent) return {available: true, conflict: null};
      arrivals++;
      if (arrivals === 2) release();
      await rendezvous;
      return {available: true, conflict: null};
    };
    return { reservation, dependencies, confirmation };
  }

  for (const sameRequestId of [true, false]) {
    await t.test(`concurrent confirmations same request ID=${sameRequestId}`, {timeout: 15000}, async () => {
      const f = await fixture();
      const results = await Promise.allSettled([
        confirmGuestReservationModification(f.confirmation, f.dependencies),
        confirmGuestReservationModification({...f.confirmation, clientRequestId: sameRequestId ? f.confirmation.clientRequestId : `${f.confirmation.clientRequestId}-other`}, f.dependencies),
      ]);
      const successes = results.filter(r => r.status === "fulfilled");
      assert.equal(successes.length, sameRequestId ? 2 : 1);
      if (sameRequestId) {
        const values = successes.map(r => r.value);
        assert.equal(values[0].modification.id, values[1].modification.id);
        assert.deepEqual(values.map(v => v.idempotentReplay).sort(), [false, true]);
      } else {
        const rejected = results.find(r => r.status === "rejected");
        assert.equal(rejected?.reason.code, "ACTIVE_RESERVATION_MODIFICATION_EXISTS");
      }
      const records = await db.reservationModification.findMany({where: {reservationId: f.reservation.id}});
      assert.equal(records.length, 1);
      assert.equal(records[0].status, "AWAITING_PAYMENT");
      assert.equal(Number(records[0].additionalChargeAmount), 100);
      assert.equal(records[0].stripeCheckoutSessionId, null);
      assert.equal(records[0].appliedAt, null);
      assert.deepEqual(await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}}), f.reservation);
      const replay = await confirmGuestReservationModification({...f.confirmation, clientRequestId: records[0].clientRequestId}, f.dependencies);
      assert.equal(replay.idempotentReplay, true);
    });
  }

  for (const change of ["none", "watchdog", "material"] as const) {
  await t.test(`checkout-only complete proposal flow after ${change} update`, async () => {
    const f = await fixture(false);
    const guestToken = f.confirmation.guestToken;
    // The public gateway requires an unexpired token; synthetic record only.
    const original = await db.reservation.update({ where: { id: f.reservation.id }, data: {
      guestTokenExpiresAt: new Date("2026-09-29T15:00:00Z"), preferredLanguage: "es",
    } });
    let checkoutCalls = 0;
    const adapter = new PinAIReservationModificationActionAdapter({
      prisma: db, now: () => new Date(now),
      getPreview: input => getGuestReservationModificationPreview(input, f.dependencies),
      createProposal: createPinAIActionProposal,
      supersedeProposal: supersedePinAIActionProposal,
      confirmModification: input => confirmGuestReservationModification(input, f.dependencies),
      createCheckout: async input => {
        checkoutCalls++;
        assert.equal(input.guestToken, guestToken);
        const modification = await db.reservationModification.findUniqueOrThrow({ where: { id: input.modificationId } });
        assert.equal(modification.status, "AWAITING_PAYMENT");
        return { checkoutUrl: "https://checkout.example.invalid/synthetic", checkoutExpiresAt: new Date("2026-09-26T23:00:00Z") };
      },
      applyModification: async () => { throw new Error("UNEXPECTED_APPLY_BEFORE_PAYMENT"); },
    });
    const broker = new PinAIActionBroker({ prisma: db, reservationModification: adapter,
      confirmProposal: confirmPinAIActionProposal, now: () => new Date(now) });
    let modelOutput = "";
    const gateway = new GuestPinAIGateway(db, async (request, _location, _session, authorization) => {
      assert.equal(authorization?.guestToken, guestToken);
      const executor = new PinAIActionProposalRuntimeToolExecutor({
        enabled: true, guestToken,
        delegate: { async execute() { throw new Error("UNEXPECTED_READ_TOOL"); } },
        getModificationOptions: input => getGuestReservationModificationOptions(input, f.dependencies),
        prepareReservationModification: input => broker.prepareReservationModification(input),
      });
      const args = { operation: "EXTEND_CHECKOUT_ONLY", proposedCheckOutDate: "2026-09-28" };
      const memory = createConversationMemory(request);
      modelOutput = JSON.stringify(await executor.execute("prepare_reservation_modification", args, request, memory));
      return { mode: "SHADOW", request, memory, actionsExecuted: false,
        response: { responseText: "Cotización preparada para extender únicamente la salida.",
          openaiSessionId: "sess_synthetic_database_contract", requiresHumanReview: false,
          escalationCreated: false, toolCalls: [{ name: "prepare_reservation_modification", arguments: args }] },
        privateActionProposal: executor.getPrivateActionProposal() };
    }, true, () => new Date(now));
    const reply = await gateway.reply({ guestToken, message: "Extiende solo mi salida al 28 de septiembre." });
    const proposal = reply.actionProposal;
    assert.ok(proposal, "Canonical proposal must reach the guest response");
    assert.equal(proposal.quote.amountDifferenceCents, 10000);
    assert.equal(proposal.quote.currentTotalAmount, 150);
    assert.equal(proposal.quote.proposedTotalAmount, 250);
    assert.equal(proposal.quote.propertyTimezone, "America/Puerto_Rico");
    assert.equal(reply.actionsExecuted, false);
    assert.equal(modelOutput.includes(proposal.confirmationToken), false);
    assert.equal(checkoutCalls, 0);
    assert.equal(await db.reservationModification.count({ where: { reservationId: original.id } }), 0);
    const stored = await db.pinAIActionProposal.findUniqueOrThrow({ where: { id: proposal.proposalId } });
    assert.equal(stored.status, "PENDING_CONFIRMATION");
    const terms = stored.termsSnapshot as { operation?: string; proposed?: { checkIn?: string; checkOut?: string } };
    assert.equal(terms.operation, "EXTEND_CHECKOUT_ONLY");
    assert.equal(terms.proposed?.checkIn, original.checkIn.toISOString());
    assert.equal(terms.proposed?.checkOut, "2026-09-28T15:00:00.000Z");
    await assert.rejects(broker.confirmAndExecute({ guestToken, proposalId: proposal.proposalId,
      confirmationToken: "z".repeat(64) }), /TOKEN_MISMATCH/);
    assert.equal(checkoutCalls, 0);
    assert.equal(await db.reservationModification.count({ where: { reservationId: original.id } }), 0);
    const beforeConfirmation = change === "none" ? original : await db.reservation.update({
      where: { id: original.id }, data: change === "material" ? { amountRefunded: 1 } : {
        lastReconciledAt: new Date(now), lastReconciledCheckIn: original.checkIn,
        lastReconciledCheckOut: original.checkOut,
      },
    });
    if (change !== "none") assert.notEqual(beforeConfirmation.updatedAt.getTime(), original.updatedAt.getTime());
    if (change === "material") {
      await assert.rejects(() => broker.confirmAndExecute({ guestToken, proposalId: proposal.proposalId,
        confirmationToken: proposal.confirmationToken }), /PROPOSAL_SUPERSEDED/);
      assert.equal(checkoutCalls, 0);
      assert.equal(await db.reservationModification.count({ where: { reservationId: original.id } }), 0);
      return;
    }
    const result = await broker.confirmAndExecute({ guestToken, proposalId: proposal.proposalId,
      confirmationToken: proposal.confirmationToken });
    assert.equal(result.outcome, "WAITING_FOR_PAYMENT");
    assert.equal(result.actionExecuted, false);
    assert.equal(result.checkoutUrl, "https://checkout.example.invalid/synthetic");
    assert.equal(checkoutCalls, 1);
    const modification = await db.reservationModification.findUniqueOrThrow({ where: { id: result.modificationId! } });
    assert.equal(modification.status, "AWAITING_PAYMENT");
    assert.equal(modification.proposedCheckIn.getTime(), original.checkIn.getTime());
    assert.equal(modification.proposedCheckOut.toISOString(), "2026-09-28T15:00:00.000Z");
    assert.equal(modification.stripeCheckoutSessionId, null);
    assert.equal((await db.pinAIActionProposal.findUniqueOrThrow({ where: { id: proposal.proposalId } })).status, "CONFIRMED");
    assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: original.id } }), beforeConfirmation);
  });
  }

  for (const change of ["watchdog", "material"] as const) {
    await t.test(`canonical preview and checkout guards after ${change} updates`, async () => {
      const f = await fixture(false);
      const confirmed = await confirmGuestReservationModification(f.confirmation, f.dependencies);
      await db.reservation.update({ where: { id: f.reservation.id }, data: change === "material"
        ? { amountRefunded: 1 }
        : { lastReconciledAt: new Date(now), lastReconciledCheckIn: f.reservation.checkIn, lastReconciledCheckOut: f.reservation.checkOut } });
      // Reach the availability boundary after the checkout's reservation guard.
      // All provider dependencies are replaced with throwing sentinels.
      let availabilityCalls = 0;
      await assert.rejects(() => createGuestReservationModificationCheckout({
        guestToken: f.confirmation.guestToken, modificationId: confirmed.modification.id,
      }, { client: db, now: () => new Date(now),
        stripe: { checkout: { sessions: {
          create: async () => { throw new Error("UNEXPECTED_PROVIDER_CALL"); },
          retrieve: async () => { throw new Error("UNEXPECTED_PROVIDER_CALL"); },
        } } } as never,
        checkAvailability: async () => { availabilityCalls++; throw new Error("SYNTHETIC_AVAILABILITY_BOUNDARY"); },
        calculatePricing: async () => { throw new Error("UNEXPECTED_PRICING_CALL"); },
        assertPayoutReady: async () => { throw new Error("UNEXPECTED_PROVIDER_CALL"); },
      }), change === "watchdog" ? /SYNTHETIC_AVAILABILITY_BOUNDARY/ : /changed before payment Checkout/);
      assert.equal(availabilityCalls, change === "watchdog" ? 1 : 0);
      assert.equal((await db.reservationModification.findUniqueOrThrow({ where: { id: confirmed.modification.id } })).stripeCheckoutSessionId, null);
    });
  }

  for (const scenario of ["apply-and-replay", "missing-payment", "blocked-dates", "changed-reservation"] as const) {
    await t.test(`real apply transaction: ${scenario}`, async () => {
      const f = await fixture(false);
      const confirmed = await confirmGuestReservationModification(f.confirmation, f.dependencies);
      const id = confirmed.modification.id;
      // Synthetic evidence only: no provider call, checkout creation or real payment.
      await db.reservationModification.update({where: {id}, data: {
        status: "APPLYING",
        ...(scenario === "missing-payment" ? {} : {
          stripeConnectedAccountId: "acct_synthetic", stripeCheckoutSessionId: `cs_synthetic_${id}`,
          stripePaymentIntentId: `pi_synthetic_${id}`, stripeChargeId: `ch_synthetic_${id}`,
          stripeApplicationFeeId: `fee_synthetic_${id}`, stripePaymentStatus: "paid",
        }),
      }});
      if (scenario === "blocked-dates") {
        await db.propertyBlockedDate.create({data: {
          propertyId: f.reservation.propertyId, startDate: f.reservation.checkOut,
          endDate: f.confirmation.checkOut,
        }});
      }
      if (scenario === "changed-reservation") {
        await db.reservation.update({where: {id: f.reservation.id}, data: {totalAmount: 151}});
      }
      const before = await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}});
      const reconciled: string[] = [];
      const dependencies = {client: db, now: () => new Date(now), reconcile: async (reservationId: string) => {reconciled.push(reservationId);} };
      if (scenario !== "apply-and-replay") {
        const expected = scenario === "missing-payment" ? "RESERVATION_MODIFICATION_PAYMENT_EVIDENCE_INCOMPLETE"
          : scenario === "blocked-dates" ? "PROPERTY_NOT_AVAILABLE_FOR_MODIFICATION_APPLY"
          : "RESERVATION_CHANGED_BEFORE_MODIFICATION_APPLY";
        await assert.rejects(applyGuestReservationModification({modificationId: id}, dependencies),
          (error: unknown) => (error as {code?: string}).code === expected);
        assert.deepEqual(await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}}), before);
        const failed = await db.reservationModification.findUniqueOrThrow({where: {id}});
        assert.equal(failed.status, "APPLYING");
        assert.equal(failed.appliedAt, null);
        assert.equal(failed.failureCode, expected);
        assert.deepEqual(reconciled, []);
      } else {
        await applyGuestReservationModification({modificationId: id}, dependencies);
        const applied = await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}});
        assert.equal(applied.checkIn.getTime(), before.checkIn.getTime());
        assert.equal(applied.checkOut.getTime(), f.confirmation.checkOut.getTime());
        assert.equal(Number(applied.totalAmount), 250);
        assert.equal(Number(applied.amountCollected), 250);
        assert.equal(Number(applied.platformFeeAmount) + Number(applied.hostPayoutAmount), 250);
        assert.equal((await db.reservationModification.findUniqueOrThrow({where: {id}})).status, "APPLIED");
        await applyGuestReservationModification({modificationId: id}, dependencies);
        assert.deepEqual(await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}}), applied);
        assert.ok(reconciled.every(value => value === f.reservation.id));
        assert.ok(reconciled.length > 0);
      }
    });
  }

});
