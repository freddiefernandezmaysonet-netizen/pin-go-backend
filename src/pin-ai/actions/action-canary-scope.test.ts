import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePinAIActionCanaryReservationIds,
  resolvePinAIActionCanaryScope,
} from "./action-canary-scope.js";

const SELECTED =
  "reservation-canary-12345678";

function env(
  overrides: Record<
    string,
    string | undefined
  > = {},
) {
  return {
    PIN_AI_ACTION_BROKER_ENABLED:
      "true",
    PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED:
      "true",
    PIN_AI_ACTION_CANARY_RESERVATION_IDS:
      SELECTED,
    ...overrides,
  };
}

test(
  "parses a comma-separated canary allowlist with whitespace and deduplication",
  () => {
    const result =
      parsePinAIActionCanaryReservationIds(
        `  ${SELECTED}, reservation-second-12345678, ${SELECTED}  `,
      );

    assert.equal(
      result.valid,
      true,
    );
    assert.deepEqual(
      [...result.ids],
      [
        SELECTED,
        "reservation-second-12345678",
      ],
    );
  },
);

test(
  "fails closed for malformed allowlist entries",
  () => {
    const parsed =
      parsePinAIActionCanaryReservationIds(
        `${SELECTED}, bad id with spaces`,
      );

    assert.equal(
      parsed.valid,
      false,
    );
    assert.equal(
      parsed.ids.size,
      0,
    );

    const resolution =
      resolvePinAIActionCanaryScope({
        reservationId:
          SELECTED,
        env: env({
          PIN_AI_ACTION_CANARY_RESERVATION_IDS:
            `${SELECTED}, bad id with spaces`,
        }),
      });

    assert.equal(
      resolution.enabled,
      false,
    );
    assert.equal(
      resolution.reason,
      "ALLOWLIST_INVALID",
    );
  },
);

test(
  "keeps actions off unless both global flags are enabled",
  () => {
    for (const overrides of [
      {
        PIN_AI_ACTION_BROKER_ENABLED:
          "false",
      },
      {
        PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED:
          "false",
      },
      {
        PIN_AI_ACTION_BROKER_ENABLED:
          undefined,
      },
      {
        PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED:
          undefined,
      },
    ]) {
      const resolution =
        resolvePinAIActionCanaryScope({
          reservationId:
            SELECTED,
          env: env(
            overrides,
          ),
        });

      assert.equal(
        resolution.enabled,
        false,
      );
      assert.equal(
        resolution.reason,
        "FLAGS_DISABLED",
      );
    }
  },
);

test(
  "keeps actions off when the allowlist is empty",
  () => {
    const resolution =
      resolvePinAIActionCanaryScope({
        reservationId:
          SELECTED,
        env: env({
          PIN_AI_ACTION_CANARY_RESERVATION_IDS:
            "",
        }),
      });

    assert.equal(
      resolution.enabled,
      false,
    );
    assert.equal(
      resolution.reason,
      "ALLOWLIST_EMPTY",
    );
  },
);

test(
  "keeps actions read-only for a reservation outside the allowlist",
  () => {
    const resolution =
      resolvePinAIActionCanaryScope({
        reservationId:
          "reservation-other-12345678",
        env: env(),
      });

    assert.equal(
      resolution.enabled,
      false,
    );
    assert.equal(
      resolution.reason,
      "RESERVATION_NOT_SELECTED",
    );
  },
);

test(
  "enables action proposals only for the explicitly selected reservation",
  () => {
    const resolution =
      resolvePinAIActionCanaryScope({
        reservationId:
          SELECTED,
        env: env(),
      });

    assert.equal(
      resolution.enabled,
      true,
    );
    assert.equal(
      resolution.reason,
      "CANARY_ACTIVE",
    );
    assert.equal(
      resolution
        .selectedReservationIds
        .has(SELECTED),
      true,
    );
  },
);
