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

test("runtime rejects every conceptually declared but disabled tool", () => {
  for (const tool of [
    "calculate_extension_price",
    "check_date_change",
    "get_cancellation_policy",
    "get_payment_context",
    "search_local_places",
  ] as const) {
    assert.throws(
      () =>
        assertRuntimeResponseSafe({
          responseText: "Not executed.",
          toolCalls: [{ name: tool, arguments: {} }],
          escalationCreated: false,
          requiresHumanReview: true,
        }),
      new RegExp(`PIN_AI_RUNTIME_TOOL_NOT_ENABLED:${tool}`),
    );
  }
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


test("runtime rejects false completion claims for shadow escalation", () => {
  assert.throws(
    () =>
      assertRuntimeResponseSafe({
        responseText: "I've sent the request to the host.",
        toolCalls: [
          {
            name: "escalate_to_host",
            arguments: {},
          },
        ],
        escalationCreated: false,
        requiresHumanReview: true,
      }),
    /PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM/,
  );
});

test("runtime allows conditional language when shadow escalation is not executed", () => {
  assert.doesNotThrow(() =>
    assertRuntimeResponseSafe({
      responseText:
        "This would be escalated to the host for review before any change is approved.",
      toolCalls: [
        {
          name: "escalate_to_host",
          arguments: {},
        },
      ],
      escalationCreated: false,
      requiresHumanReview: true,
    }),
  );
});
