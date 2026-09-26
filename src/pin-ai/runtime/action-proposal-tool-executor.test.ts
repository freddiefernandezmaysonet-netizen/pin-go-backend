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
