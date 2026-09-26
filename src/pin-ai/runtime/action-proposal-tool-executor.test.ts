import assert from "node:assert/strict";
import test from "node:test";

import type {
  PinAIRuntimeRequest,
} from "./contracts.js";
import {
  createConversationMemory,
} from "./conversation-memory.js";
import {
  PinAIActionProposalRuntimeToolExecutor,
  type PinAIActionProposalRuntimeToolDependencies,
} from "./action-proposal-tool-executor.js";

const request: PinAIRuntimeRequest = {
  context: {
    organizationId: "org-a",
    propertyId: "property-a",
    reservationId: "reservation-a",
    guestId: "reservation-guest",
    currentLocalDateTime:
      "2026-09-26T10:00:00-04:00",
    preferredLanguage: "es",
  },
  conversation: [
    {
      role: "guest",
      content:
        "Quiero quedarme hasta el 5 de octubre.",
    },
  ],
};

function createHarness(
  enabled = true,
  currentOptions?: Awaited<ReturnType<PinAIActionProposalRuntimeToolDependencies["getModificationOptions"]>>,
) {
  let delegateCalls = 0;
  let prepareCalls = 0;
  let receivedPrepare:
    Record<string, unknown> |
    null = null;

  const executor =
    new PinAIActionProposalRuntimeToolExecutor({
      delegate: {
        async execute() {
          delegateCalls += 1;
          return {
            decision:
              "READ_DELEGATED",
          };
        },
      },
      enabled,
      guestToken:
        "12345678-1234-1234-1234-123456789abc",
      async getModificationOptions() {
        if (currentOptions) return currentOptions;
        return {
          reservation: {
            current: {
              adults: 2,
              children: 0,
              selectedAmenityIds: [
                "amenity-b",
                "amenity-a",
              ],
            },
          },
          property: {
            timezone:
              "America/Puerto_Rico",
            checkInTime:
              "16:00",
            checkOutTime:
              "11:00",
          },
        };
      },
      async prepareReservationModification(
        input,
      ) {
        prepareCalls += 1;
        receivedPrepare = {
          ...input,
        };

        const expiresAt =
          new Date(
            "2026-09-26T15:00:00.000Z",
          );

        return {
          publicResult: {
            actionType:
              "RESERVATION_MODIFICATION",
            proposalId:
              "proposal-12345678",
            requiresGuestConfirmation:
              true,
            actionExecuted:
              false,
            quote: {
              quotedAt:
                new Date(
                  "2026-09-26T14:00:00.000Z",
                ),
              quoteExpiresAt:
                expiresAt,
              quoteExpiresAtLocal:
                "2026-09-26T11:00:00-04:00",
              priceGuaranteedUntil:
                expiresAt,
              propertyTimezone:
                "America/Puerto_Rico",
              availabilityCheckedAt:
                new Date(
                  "2026-09-26T14:00:00.000Z",
                ),
              availabilityHeld:
                false,
              currentTotalAmount:
                353.35,
              proposedTotalAmount:
                521.85,
              amountDifference:
                168.5,
              amountDifferenceCents:
                16_850,
              currency: "usd",
              financialAction:
                "ADDITIONAL_PAYMENT_REQUIRED",
            },
          },
          privateConfirmation: {
            proposalId:
              "proposal-12345678",
            confirmationToken:
              "confirmation-token-private-123456789012345",
            expiresAt,
          },
        };
      },
    });

  return {
    executor,
    getDelegateCalls:
      () => delegateCalls,
    getPrepareCalls:
      () => prepareCalls,
    getReceivedPrepare:
      () => receivedPrepare,
  };
}

test(
  "delegates existing read tools unchanged",
  async () => {
    const harness =
      createHarness();
    const memory =
      createConversationMemory(
        request,
      );

    const result =
      await harness.executor
        .execute(
          "get_reservation_context",
          {},
          request,
          memory,
        );

    assert.deepEqual(
      result,
      {
        decision:
          "READ_DELEGATED",
      },
    );
    assert.equal(
      harness.getDelegateCalls(),
      1,
    );
    assert.equal(
      harness.getPrepareCalls(),
      0,
    );
  },
);

test(
  "prepares exact property-local stay timestamps without exposing the private confirmation token",
  async () => {
    const harness =
      createHarness();
    const memory =
      createConversationMemory(
        request,
      );

    const result =
      await harness.executor
        .execute(
          "prepare_reservation_modification",
          {
            proposedCheckInDate:
              "2026-10-01",
            proposedCheckOutDate:
              "2026-10-05",
          },
          request,
          memory,
        );

    assert.equal(
      result.decision,
      "ACTION_PROPOSAL_PREPARED",
    );
    assert.equal(
      result.actionExecuted,
      false,
    );
    assert.equal(
      result.availabilityHeld,
      false,
    );
    assert.equal(
      JSON.stringify(
        result,
      ).includes(
        "confirmation-token-private",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(
        result,
      ).includes(
        "confirmationToken",
      ),
      false,
    );

    const received =
      harness
        .getReceivedPrepare()!;
    assert.equal(
      (
        received.checkIn as Date
      ).toISOString(),
      "2026-10-01T20:00:00.000Z",
    );
    assert.equal(
      (
        received.checkOut as Date
      ).toISOString(),
      "2026-10-05T15:00:00.000Z",
    );
    assert.deepEqual(
      received.selectedAmenityIds,
      [
        "amenity-a",
        "amenity-b",
      ],
    );
    assert.equal(
      received.adults,
      2,
    );
    assert.equal(
      received.children,
      0,
    );
    assert.equal(
      received.language,
      "es",
    );

    const privateProposal =
      harness.executor
        .getPrivateActionProposal();

    assert.equal(
      privateProposal
        ?.privateConfirmation
        .confirmationToken,
      "confirmation-token-private-123456789012345",
    );
  },
);

test(
  "replays the same proposal tool call without creating or rotating a second proposal",
  async () => {
    const harness =
      createHarness();
    const memory =
      createConversationMemory(
        request,
      );
    const args = {
      proposedCheckInDate:
        "2026-10-01",
      proposedCheckOutDate:
        "2026-10-05",
    };

    const first =
      await harness.executor
        .execute(
          "prepare_reservation_modification",
          args,
          request,
          memory,
        );
    const replay =
      await harness.executor
        .execute(
          "prepare_reservation_modification",
          args,
          request,
          memory,
        );

    assert.deepEqual(
      replay,
      first,
    );
    assert.equal(
      harness.getPrepareCalls(),
      1,
    );
  },
);

test(
  "forbids a second distinct proposal in the same runtime turn",
  async () => {
    const harness =
      createHarness();
    const memory =
      createConversationMemory(
        request,
      );

    await harness.executor
      .execute(
        "prepare_reservation_modification",
        {
          proposedCheckInDate:
            "2026-10-01",
          proposedCheckOutDate:
            "2026-10-05",
        },
        request,
        memory,
      );

    await assert.rejects(
      () =>
        harness.executor
          .execute(
            "prepare_reservation_modification",
            {
              proposedCheckInDate:
                "2026-10-01",
              proposedCheckOutDate:
                "2026-10-06",
            },
            request,
            memory,
          ),
      /PIN_AI_RUNTIME_MULTIPLE_ACTION_PROPOSALS_FORBIDDEN/,
    );

    assert.equal(
      harness.getPrepareCalls(),
      1,
    );
  },
);

test(
  "fails closed when the proposal tool executor gate is disabled",
  async () => {
    const harness =
      createHarness(false);
    const memory =
      createConversationMemory(
        request,
      );

    await assert.rejects(
      () =>
        harness.executor
          .execute(
            "prepare_reservation_modification",
            {
              proposedCheckInDate:
                "2026-10-01",
              proposedCheckOutDate:
                "2026-10-05",
            },
            request,
            memory,
          ),
      /PIN_AI_RUNTIME_ACTION_PROPOSAL_TOOL_DISABLED/,
    );

    assert.equal(
      harness.getPrepareCalls(),
      0,
    );
  },
);

const inStayOptions = {
  managementPhase: "IN_STAY",
  reservation: { current: {
    checkIn: new Date("2026-09-26T18:17:03.123Z"),
    checkOut: new Date("2026-09-27T15:00:00Z"),
    adults: 2, children: 0, selectedAmenityIds: ["breakfast"],
  } },
  property: { timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00" },
};

test("checkout-only proposal preserves the persisted check-in including custom time and milliseconds", async () => {
  const h = createHarness(true, inStayOptions);
  const args = { operation: "EXTEND_CHECKOUT_ONLY", proposedCheckOutDate: "2026-09-28" };
  const memory = createConversationMemory(request);
  const first = await h.executor.execute("prepare_reservation_modification", args, request, memory);
  assert.equal(first.decision, "ACTION_PROPOSAL_PREPARED");
  assert.equal(first.actionExecuted, false);
  const input = h.getReceivedPrepare()!;
  assert.equal(input.operation, "EXTEND_CHECKOUT_ONLY");
  assert.equal((input.checkIn as Date).toISOString(), "2026-09-26T18:17:03.123Z");
  assert.equal((input.checkOut as Date).toISOString(), "2026-09-28T15:00:00.000Z");
  assert.deepEqual(input.selectedAmenityIds, ["breakfast"]);
  await h.executor.execute("prepare_reservation_modification", args, request, memory);
  assert.equal(h.getPrepareCalls(), 1);
});

for (const [name, args, options, expected] of [
  ["changing check-in", { operation: "EXTEND_CHECKOUT_ONLY", proposedCheckInDate: "2026-09-25", proposedCheckOutDate: "2026-09-28" }, inStayOptions, "CHECK_IN_IMMUTABLE"],
  ["unchanged checkout", { operation: "EXTEND_CHECKOUT_ONLY", proposedCheckOutDate: "2026-09-27" }, inStayOptions, "DATES_INVALID"],
  ["shorter checkout", { operation: "EXTEND_CHECKOUT_ONLY", proposedCheckOutDate: "2026-09-26" }, inStayOptions, "DATES_INVALID"],
  ["missing operation during in-stay", { proposedCheckInDate: "2026-09-26", proposedCheckOutDate: "2026-09-28" }, inStayOptions, "OPERATION_REQUIRED"],
  ["extension outside in-stay", { operation: "EXTEND_CHECKOUT_ONLY", proposedCheckOutDate: "2026-09-28" }, { ...inStayOptions, managementPhase: "PRE_STAY" }, "CONTEXT_INVALID"],
  ["unknown operation", { operation: "CHANGE_CHECK_IN", proposedCheckOutDate: "2026-09-28" }, inStayOptions, "OPERATION_INVALID"],
  ["missing pre-stay check-in", { proposedCheckOutDate: "2026-09-28" }, { ...inStayOptions, managementPhase: "PRE_STAY" }, "DATES_INVALID"],
] as const) {
  test(`rejects ${name} before creating a proposal`, async () => {
    const h = createHarness(true, options);
    await assert.rejects(h.executor.execute("prepare_reservation_modification", args, request, createConversationMemory(request)), new RegExp(expected));
    assert.equal(h.getPrepareCalls(), 0);
  });
}

for (const enabled of [true, false]) {
  test(`canonical extension estimate is gated without preparing a proposal: enabled=${enabled}`, async () => {
    let estimates = 0;
    let delegated = 0;
    const forbidden = async (): Promise<never> => { throw new Error("UNEXPECTED_PROPOSAL_WRITE"); };
    const executor = new PinAIActionProposalRuntimeToolExecutor({
      enabled, guestToken: "test-token",
      delegate: { async execute() { delegated++; return { decision: "LEGACY_ESTIMATE" }; } },
      getModificationOptions: forbidden,
      prepareReservationModification: forbidden,
      estimateInStayExtension: async () => { estimates++; return { decision: "CANONICAL_ESTIMATE" }; },
    });
    const result = await executor.execute("calculate_extension_price", {additionalNights: 1}, request, createConversationMemory(request));
    assert.equal(result.decision, enabled ? "CANONICAL_ESTIMATE" : "LEGACY_ESTIMATE");
    assert.equal(estimates, enabled ? 1 : 0);
    assert.equal(delegated, enabled ? 0 : 1);
    assert.equal(executor.getPrivateActionProposal(), null);
  });
}

test("pre-stay extension estimate delegates when canonical in-stay estimator returns null", async () => {
  const forbidden = async (): Promise<never> => { throw new Error("UNEXPECTED_PROPOSAL_WRITE"); };
  const executor = new PinAIActionProposalRuntimeToolExecutor({
    enabled: true, guestToken: "test-token",
    delegate: { async execute() { return {decision: "LEGACY_ESTIMATE"}; } },
    getModificationOptions: forbidden, prepareReservationModification: forbidden,
    estimateInStayExtension: async () => null,
  });
  const result = await executor.execute("calculate_extension_price", {additionalNights: 1}, request, createConversationMemory(request));
  assert.equal(result.decision, "LEGACY_ESTIMATE");
  assert.equal(executor.getPrivateActionProposal(), null);
});
