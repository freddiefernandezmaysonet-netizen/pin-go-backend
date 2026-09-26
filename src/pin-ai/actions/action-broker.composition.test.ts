import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultPinAIActionBroker,
} from "./action-broker.composition.js";

test(
  "constructs the default broker without loading Stripe providers",
  () => {
    const previous =
      process.env.STRIPE_SECRET_KEY;
    delete process.env
      .STRIPE_SECRET_KEY;

    try {
      const broker =
        createDefaultPinAIActionBroker({
          now: () =>
            new Date(
              "2026-09-26T14:00:00.000Z",
            ),
        });

      assert.ok(broker);
      assert.equal(
        typeof broker
          .prepareReservationModification,
        "function",
      );
      assert.equal(
        typeof broker
          .confirmAndExecute,
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
