import assert from "node:assert/strict";
import test from "node:test";
import { processRecoverableWebhookBatch } from "./pms-webhook-recovery.policy";

const events = [
  {
    id: "event-1",
    provider: "CHANNEX",
    eventType: "booking",
    status: "FAILED" as const,
    attempts: 2,
  },
  {
    id: "event-2",
    provider: "CHANNEX",
    eventType: "booking_modification",
    status: "PENDING" as const,
    attempts: 0,
  },
];

test("one failed event does not block later events in the batch", async () => {
  const dispatched: string[] = [];
  const errors: string[] = [];

  const result = await processRecoverableWebhookBatch({
    events,
    releaseStaleProcessingEvent: async () => true,
    dispatchEvent: async (eventId) => {
      dispatched.push(eventId);
      if (eventId === "event-1") {
        throw new Error("first event failed");
      }
    },
    onEventError: async (event) => {
      errors.push(event.id);
    },
  });

  assert.deepEqual(dispatched, ["event-1", "event-2"]);
  assert.deepEqual(errors, ["event-1"]);
  assert.deepEqual(result, {
    processedCount: 1,
    failedCount: 1,
    skippedCount: 0,
  });
});

test("stale PROCESSING events are skipped when their lease cannot be released", async () => {
  const dispatched: string[] = [];

  const result = await processRecoverableWebhookBatch({
    events: [
      {
        id: "event-stale",
        provider: "CHANNEX",
        eventType: "booking",
        status: "PROCESSING",
        attempts: 1,
      },
      {
        id: "event-next",
        provider: "CHANNEX",
        eventType: "booking_new",
        status: "PENDING",
        attempts: 0,
      },
    ],
    releaseStaleProcessingEvent: async (eventId) =>
      eventId !== "event-stale",
    dispatchEvent: async (eventId) => {
      dispatched.push(eventId);
    },
  });

  assert.deepEqual(dispatched, ["event-next"]);
  assert.deepEqual(result, {
    processedCount: 1,
    failedCount: 0,
    skippedCount: 1,
  });
});
