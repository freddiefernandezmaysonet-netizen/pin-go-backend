import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoDirectIrreversibleAction,
  assertRuntimeRequestScoped,
  assertRuntimeResponseSafe,
} from "./policy.js";

test("runtime requires fully scoped stay context", () => {
  assert.throws(
    () =>
      assertRuntimeRequestScoped({
        context: {
          organizationId: "",
          propertyId: "property-a",
          reservationId: "reservation-a",
          guestId: "guest-a",
          currentLocalDateTime: "2026-09-20T09:00:00-04:00",
        },
        conversation: [{ role: "guest", content: "Hi" }],
      }),
    /PIN_AI_RUNTIME_CONTEXT_INCOMPLETE/,
  );
});

test("runtime permits bounded read and escalation tools", () => {
  assert.doesNotThrow(() =>
    assertRuntimeResponseSafe({
      responseText: "I checked the current access state and escalated the issue.",
      toolCalls: [
        { name: "get_access_status", arguments: {} },
        { name: "escalate_to_host", arguments: { priority: "URGENT" } },
      ],
      escalationCreated: true,
      requiresHumanReview: true,
    }),
  );
});

test("runtime rejects operational secrets in tool payloads", () => {
  assert.throws(
    () =>
      assertRuntimeResponseSafe({
        responseText: "Unsafe",
        toolCalls: [
          {
            name: "get_access_status",
            arguments: { activePasscode: "123456" },
          },
        ],
        escalationCreated: false,
        requiresHumanReview: false,
      }),
    /PIN_AI_RUNTIME_FORBIDDEN_FIELD/,
  );
});

test("runtime forbids direct irreversible actions", () => {
  for (const action of [
    "cancel_reservation",
    "issue_refund",
    "charge_guest",
    "create_access_credential",
    "activate_access_credential",
    "change_reservation_dates",
  ]) {
    assert.throws(
      () => assertNoDirectIrreversibleAction(action),
      new RegExp(`PIN_AI_RUNTIME_DIRECT_IRREVERSIBLE_ACTION_FORBIDDEN:${action}`),
    );
  }
});
