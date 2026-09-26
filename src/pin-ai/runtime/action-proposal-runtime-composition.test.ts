import assert from "node:assert/strict";
import test from "node:test";

import {
  createActionProposalRuntimeDependencies,
} from "./action-proposal-runtime-composition.js";

test(
  "constructs hidden action-proposal runtime dependencies without loading Stripe providers",
  () => {
    const previous =
      process.env.STRIPE_SECRET_KEY;
    delete process.env
      .STRIPE_SECRET_KEY;

    try {
      const dependencies =
        createActionProposalRuntimeDependencies({
          guestToken:
            "12345678-1234-1234-1234-123456789abc",
          enabled: true,
          now: () =>
            new Date(
              "2026-09-26T14:00:00.000Z",
            ),
        });

      assert.equal(
        dependencies.enabled,
        true,
      );
      assert.equal(
        dependencies.guestToken,
        "12345678-1234-1234-1234-123456789abc",
      );
      assert.equal(
        typeof dependencies
          .getModificationOptions,
        "function",
      );
      assert.equal(
        typeof dependencies
          .prepareReservationModification,
        "function",
      );
    } finally {
      if (
        previous === undefined
      ) {
        delete process.env
          .STRIPE_SECRET_KEY;
      } else {
        process.env
          .STRIPE_SECRET_KEY =
          previous;
      }
    }
  },
);
