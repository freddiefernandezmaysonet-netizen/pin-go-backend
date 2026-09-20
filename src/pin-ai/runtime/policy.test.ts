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
  for (const tool of ["search_local_places"] as const) {
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

test("runtime rejects equivalent shadow escalation completion claims", () => {
  for (const responseText of [
    "The host has been notified.",
    "I submitted the combined request.",
    "I'm sending both requests for host review.",
    "I am forwarding your request to the host.",
    "Your request has been forwarded to the host.",
    "Le envié la solicitud al anfitrión.",
    "Estoy enviando ambas solicitudes al anfitrión.",
    "La solicitud fue enviada al anfitrión.",
  ]) {
    assert.throws(
      () =>
        assertRuntimeResponseSafe({
          responseText,
          toolCalls: [{ name: "escalate_to_host", arguments: {} }],
          escalationCreated: false,
          requiresHumanReview: true,
        }),
      /PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM/,
    );
  }
});

test("runtime rejects escalation completion claims even without a tool call", () => {
  assert.throws(
    () =>
      assertRuntimeResponseSafe({
        responseText: "I've sent the request to the host.",
        toolCalls: [],
        escalationCreated: false,
        requiresHumanReview: true,
      }),
    /PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM/,
  );
});

test("runtime rejects false approval or mutation claims after eligibility checks", () => {
  for (const testCase of [
    {
      responseText: "Your late checkout has been approved.",
      tool: "check_late_checkout",
    },
    {
      responseText: "Your stay extension is confirmed.",
      tool: "check_extension_availability",
    },
    {
      responseText: "La salida tardía fue aprobada.",
      tool: "check_late_checkout",
    },
    {
      responseText: "Su reservación ha sido extendida.",
      tool: "check_extension_availability",
    },
    {
      responseText: "Your reservation has been changed to the new dates.",
      tool: "check_date_change",
    },
    {
      responseText: "Su reserva ha sido modificada a las nuevas fechas.",
      tool: "check_date_change",
    },
  ] as const) {
    assert.throws(
      () =>
        assertRuntimeResponseSafe({
          responseText: testCase.responseText,
          toolCalls: [{ name: testCase.tool, arguments: {} }],
          escalationCreated: false,
          requiresHumanReview: true,
        }),
      /PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM/,
    );
  }
});

test("runtime rejects false charge or final-price claims after extension pricing", () => {
  for (const responseText of [
    "You've been charged $100 for the additional night.",
    "Your payment has been processed.",
    "The extension price is final.",
    "Le cobré $100 por la noche adicional.",
    "Su pago ha sido procesado.",
    "El precio de extensión es final.",
  ]) {
    assert.throws(
      () =>
        assertRuntimeResponseSafe({
          responseText,
          toolCalls: [
            { name: "check_extension_availability", arguments: {} },
          ],
          escalationCreated: false,
          requiresHumanReview: true,
        }),
      /PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM/,
    );
  }
});

test("runtime rejects false cancellation and refund completion claims", () => {
  for (const responseText of [
    "Your reservation has been cancelled.",
    "Your cancellation is confirmed.",
    "I've issued your refund.",
    "Your refund has been processed.",
    "You will receive a full refund.",
    "Su reservación ha sido cancelada.",
    "Su reembolso ha sido procesado.",
    "He emitido su reembolso.",
    "Recibirá un reembolso.",
  ]) {
    assert.throws(
      () =>
        assertRuntimeResponseSafe({
          responseText,
          toolCalls: [{ name: "get_cancellation_policy", arguments: {} }],
          escalationCreated: false,
          requiresHumanReview: false,
        }),
      /PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM/,
    );
  }
});

test("runtime rejects false compensation or transfer completion claims", () => {
  for (const responseText of [
    "I've issued your service credit.",
    "Your compensation has been approved.",
    "The transfer has been processed.",
    "He emitido su crédito.",
    "Su compensación ha sido aprobada.",
    "Su transferencia fue procesada.",
  ]) {
    assert.throws(
      () =>
        assertRuntimeResponseSafe({
          responseText,
          toolCalls: [{ name: "get_payment_context", arguments: {} }],
          escalationCreated: false,
          requiresHumanReview: false,
        }),
      /PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM/,
    );
  }
});

test("runtime rejects false local booking claims after web search", () => {
  for (const responseText of [
    "I've booked a table for you.",
    "Your restaurant reservation has been confirmed.",
    "He reservado una mesa para usted.",
  ]) {
    assert.throws(
      () =>
        assertRuntimeResponseSafe({
          responseText,
          toolCalls: [],
          webSearch: { enabled: true, used: true, callCount: 1 },
          escalationCreated: false,
          requiresHumanReview: false,
        }),
      /PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM/,
    );
  }
});

test("runtime allows conditional language when shadow escalation is not executed", () => {
  for (const responseText of [
    "This would be escalated to the host for review before any change is approved.",
    "The host has not been notified. This requires host review.",
    "Your late checkout is available for review, but it is not yet approved.",
    "La extensión está disponible, pero aún no ha sido aprobada.",
    "No reservation changes or charges have been made.",
    "The estimated additional cost is $100; no charge or reservation change has been made.",
    "El costo adicional estimado es $100; no se realizó ningún cargo ni cambio de reserva.",
    "If you cancel now, the estimated refund would be $100; no cancellation or refund has been executed.",
    "Si cancela ahora, el reembolso estimado sería $100; no se ha cancelado la reserva ni emitido un reembolso.",
    "The reservation currently records a paid payment state; no new charge, refund, transfer, or compensation was executed.",
    "La reservación registra actualmente un estado de pago pagado; no se ejecutó ningún cargo, reembolso, transferencia ni compensación nueva.",
  ]) {
    assert.doesNotThrow(() =>
      assertRuntimeResponseSafe({
        responseText,
        toolCalls: [
          {
            name: "check_late_checkout",
            arguments: {},
          },
          {
            name: "check_extension_availability",
            arguments: {},
          },
          {
            name: "escalate_to_host",
            arguments: {},
          },
        ],
        escalationCreated: false,
        requiresHumanReview: true,
      }),
    );
  }
});
