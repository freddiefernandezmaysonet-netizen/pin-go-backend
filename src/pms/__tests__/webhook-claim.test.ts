import assert from "node:assert/strict";
import test from "node:test";

import type {
  PrismaClient,
} from "@prisma/client";

import {
  claimWebhookEventForProcessing,
} from "../ingest/webhook.processor";

function createEvent(
  status: "PENDING" | "PROCESSING" | "FAILED" | "PROCESSED"
) {
  return {
    id: "event-test",
    connectionId: "connection-test",
    provider: "LODGIFY",
    eventType: "booking.updated",
    externalEventId: "external-test",
    payloadRaw: {},
    status,
    attempts: 0,
    lastError: null,
    receivedAt: new Date(),
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;
}

test("returns not found without attempting a claim", async () => {
  let updateCalled = false;

  const db = {
    webhookEventIngest: {
      findUnique: async () => null,
      updateMany: async () => {
        updateCalled = true;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  const result =
    await claimWebhookEventForProcessing(
      db,
      "missing-event"
    );

  assert.equal(result.claimed, false);
  assert.equal(
    result.reason,
    "EVENT_NOT_FOUND"
  );
  assert.equal(updateCalled, false);
});

test("claims pending and failed events with a conditional status guard", async () => {
  for (const initialStatus of [
    "PENDING",
    "FAILED",
  ] as const) {
    let receivedWhere: unknown = null;
    let receivedData: unknown = null;

    const db = {
      webhookEventIngest: {
        findUnique: async () =>
          createEvent(initialStatus),
        updateMany: async (input: {
          where: unknown;
          data: unknown;
        }) => {
          receivedWhere = input.where;
          receivedData = input.data;
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    const result =
      await claimWebhookEventForProcessing(
        db,
        "event-test"
      );

    assert.equal(result.claimed, true);
    assert.equal(
      result.reason,
      "EVENT_CLAIMED"
    );
    assert.deepEqual(receivedWhere, {
      id: "event-test",
      status: {
        in: ["PENDING", "FAILED"],
      },
    });
    assert.deepEqual(receivedData, {
      status: "PROCESSING",
      attempts: {
        increment: 1,
      },
    });
  }
});

test("allows exactly one winner when two processors race for the same event", async () => {
  let status:
    | "PENDING"
    | "PROCESSING" = "PENDING";
  let attempts = 0;

  const db = {
    webhookEventIngest: {
      findUnique: async () =>
        createEvent(status),
      updateMany: async (input: {
        where: {
          status: {
            in: string[];
          };
        };
      }) => {
        if (
          !input.where.status.in.includes(
            status
          )
        ) {
          return { count: 0 };
        }

        status = "PROCESSING";
        attempts += 1;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  const results = await Promise.all([
    claimWebhookEventForProcessing(
      db,
      "event-test"
    ),
    claimWebhookEventForProcessing(
      db,
      "event-test"
    ),
  ]);

  assert.equal(
    results.filter(
      (result) => result.claimed
    ).length,
    1
  );
  assert.equal(
    results.filter(
      (result) => !result.claimed
    ).length,
    1
  );
  assert.equal(status, "PROCESSING");
  assert.equal(attempts, 1);
});

test("does not claim an event already processing or terminal", async () => {
  for (const initialStatus of [
    "PROCESSING",
    "PROCESSED",
  ] as const) {
    const db = {
      webhookEventIngest: {
        findUnique: async () =>
          createEvent(initialStatus),
        updateMany: async () => ({
          count: 0,
        }),
      },
    } as unknown as PrismaClient;

    const result =
      await claimWebhookEventForProcessing(
        db,
        "event-test"
      );

    assert.equal(result.claimed, false);
    assert.equal(
      result.reason,
      "EVENT_ALREADY_CLAIMED_OR_TERMINAL"
    );
  }
});
