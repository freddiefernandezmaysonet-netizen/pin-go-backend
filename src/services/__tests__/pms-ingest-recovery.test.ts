import assert from "node:assert/strict";
import test from "node:test";

import type {
  PrismaClient,
} from "@prisma/client";

import {
  getPmsIngestRecoveryBackoffMs,
  processPmsIngestRecovery,
} from "../pms-ingest-recovery.service";
import type {
  PmsIngestRecoveryEventContext,
} from "../pms-ingest-recovery.service";

const NOW = new Date(
  "2026-07-24T18:30:00.000Z"
);

type FakeEventStatus =
  | "PENDING"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED";

type FakeEvent = {
  id: string;
  connectionId: string;
  provider: string;
  eventType: string;
  status: FakeEventStatus;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  updatedAt: Date;
  connection: {
    organizationId: string;
    status: string;
  };
};

function minutesBefore(minutes: number) {
  return new Date(
    NOW.getTime() - minutes * 60_000
  );
}

function createEvent(
  overrides: Partial<FakeEvent> = {}
): FakeEvent {
  return {
    id: "event-test",
    connectionId: "connection-test",
    provider: "LODGIFY",
    eventType: "booking.updated",
    status: "FAILED",
    attempts: 1,
    lastError: "temporary provider error",
    receivedAt: minutesBefore(30),
    updatedAt: minutesBefore(5),
    connection: {
      organizationId: "org-test",
      status: "ACTIVE",
    },
    ...overrides,
  };
}

function matchesStatus(
  value: unknown,
  status: FakeEventStatus
) {
  if (typeof value === "string") {
    return value === status;
  }

  if (
    value &&
    typeof value === "object" &&
    "in" in value &&
    Array.isArray(
      (value as { in?: unknown }).in
    )
  ) {
    return (
      (value as { in: unknown[] }).in
        .map(String)
        .includes(status)
    );
  }

  return true;
}

function createFakePrisma(
  initialEvents: FakeEvent[]
) {
  const events = new Map(
    initialEvents.map((event) => [
      event.id,
      event,
    ])
  );

  const prisma = {
    webhookEventIngest: {
      findMany: async (input: any) => {
        const statusWhere =
          input?.where?.status;
        const updatedAtLte =
          input?.where?.updatedAt?.lte as
            | Date
            | undefined;

        return Array.from(events.values())
          .filter((event) =>
            matchesStatus(
              statusWhere,
              event.status
            )
          )
          .filter((event) =>
            updatedAtLte
              ? event.updatedAt <=
                updatedAtLte
              : true
          )
          .sort(
            (left, right) =>
              left.updatedAt.getTime() -
              right.updatedAt.getTime()
          )
          .slice(0, input?.take ?? 100);
      },
      updateMany: async (input: any) => {
        const event = events.get(
          String(input?.where?.id ?? "")
        );

        if (!event) {
          return { count: 0 };
        }

        if (
          !matchesStatus(
            input?.where?.status,
            event.status
          )
        ) {
          return { count: 0 };
        }

        const updatedAtLte =
          input?.where?.updatedAt?.lte as
            | Date
            | undefined;

        if (
          updatedAtLte &&
          event.updatedAt > updatedAtLte
        ) {
          return { count: 0 };
        }

        if (input?.data?.status) {
          event.status =
            input.data.status;
        }

        if (
          input?.data?.lastError !==
          undefined
        ) {
          event.lastError =
            input.data.lastError;
        }

        if (
          input?.data?.attempts?.increment
        ) {
          event.attempts += Number(
            input.data.attempts.increment
          );
        }

        event.updatedAt = NOW;
        return { count: 1 };
      },
      findUnique: async (input: any) =>
        events.get(
          String(input?.where?.id ?? "")
        ) ?? null,
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    events,
  };
}

function createLifecycleCapture() {
  const states:
    PmsIngestRecoveryEventContext[] = [];
  const resolutions: Array<
    Omit<
      PmsIngestRecoveryEventContext,
      "state" | "nextAttemptAt"
    >
  > = [];

  return {
    states,
    resolutions,
    recordState: async (
      input: PmsIngestRecoveryEventContext
    ) => {
      states.push(input);
    },
    resolveState: async (
      input: Omit<
        PmsIngestRecoveryEventContext,
        "state" | "nextAttemptAt"
      >
    ) => {
      resolutions.push(input);
    },
  };
}

test("uses bounded PMS recovery backoff", () => {
  assert.equal(
    getPmsIngestRecoveryBackoffMs(0),
    0
  );
  assert.equal(
    getPmsIngestRecoveryBackoffMs(1),
    60_000
  );
  assert.equal(
    getPmsIngestRecoveryBackoffMs(2),
    5 * 60_000
  );
  assert.equal(
    getPmsIngestRecoveryBackoffMs(3),
    15 * 60_000
  );
  assert.equal(
    getPmsIngestRecoveryBackoffMs(4),
    60 * 60_000
  );
  assert.equal(
    getPmsIngestRecoveryBackoffMs(20),
    60 * 60_000
  );
});

test("releases an abandoned PROCESSING lease and schedules automatic recovery", async () => {
  const { prisma, events } =
    createFakePrisma([
      createEvent({
        status: "PROCESSING",
        attempts: 1,
        updatedAt: minutesBefore(20),
      }),
    ]);
  const lifecycle =
    createLifecycleCapture();
  let processCalls = 0;

  const result =
    await processPmsIngestRecovery(
      prisma,
      NOW,
      {
        staleProcessingMs:
          10 * 60_000,
        processEvent: async () => {
          processCalls += 1;
        },
        recordState:
          lifecycle.recordState,
        resolveState:
          lifecycle.resolveState,
      }
    );

  assert.equal(result.staleReleased, 1);
  assert.equal(result.scanned, 1);
  assert.equal(result.scheduled, 1);
  assert.equal(result.attempted, 0);
  assert.equal(processCalls, 0);
  assert.equal(
    events.get("event-test")?.status,
    "FAILED"
  );
  assert.equal(
    events.get("event-test")?.lastError,
    "PMS_INGEST_PROCESSING_LEASE_EXPIRED"
  );
  assert.equal(
    lifecycle.states[0]?.state,
    "WAITING"
  );
  assert.equal(
    lifecycle.states[0]
      ?.nextAttemptAt?.toISOString(),
    new Date(
      NOW.getTime() + 60_000
    ).toISOString()
  );
});

test("resolves the operational workflow after a due retry succeeds", async () => {
  const { prisma, events } =
    createFakePrisma([
      createEvent({
        status: "FAILED",
        attempts: 1,
        updatedAt: minutesBefore(5),
      }),
    ]);
  const lifecycle =
    createLifecycleCapture();

  const result =
    await processPmsIngestRecovery(
      prisma,
      NOW,
      {
        processEvent: async (eventId) => {
          const event = events.get(eventId);
          assert.ok(event);
          event.status = "PROCESSED";
          event.attempts += 1;
          event.lastError = null;
          event.updatedAt = NOW;
        },
        recordState:
          lifecycle.recordState,
        resolveState:
          lifecycle.resolveState,
      }
    );

  assert.equal(result.attempted, 1);
  assert.equal(result.recovered, 1);
  assert.equal(result.exhausted, 0);
  assert.deepEqual(
    lifecycle.states.map(
      (state) => state.state
    ),
    ["RUNNING"]
  );
  assert.equal(
    lifecycle.resolutions.length,
    1
  );
  assert.equal(
    lifecycle.resolutions[0]
      ?.attemptCount,
    2
  );
});

test("keeps ownership and schedules the next backoff after a retry fails", async () => {
  const { prisma, events } =
    createFakePrisma([
      createEvent({
        status: "FAILED",
        attempts: 2,
        updatedAt: minutesBefore(10),
      }),
    ]);
  const lifecycle =
    createLifecycleCapture();

  const result =
    await processPmsIngestRecovery(
      prisma,
      NOW,
      {
        maxAttempts: 5,
        processEvent: async (eventId) => {
          const event = events.get(eventId);
          assert.ok(event);
          event.status = "FAILED";
          event.attempts += 1;
          event.lastError =
            "provider still unavailable";
          event.updatedAt = NOW;
        },
        recordState:
          lifecycle.recordState,
        resolveState:
          lifecycle.resolveState,
      }
    );

  assert.equal(result.attempted, 1);
  assert.equal(result.recovered, 0);
  assert.equal(result.scheduled, 1);
  assert.deepEqual(
    lifecycle.states.map(
      (state) => state.state
    ),
    ["RUNNING", "WAITING"]
  );
  assert.equal(
    lifecycle.states[1]
      ?.nextAttemptAt?.toISOString(),
    new Date(
      NOW.getTime() +
        15 * 60_000
    ).toISOString()
  );
  assert.equal(
    lifecycle.states[1]?.attemptCount,
    3
  );
});

test("transfers responsibility only after the retry budget is exhausted", async () => {
  const { prisma } =
    createFakePrisma([
      createEvent({
        status: "FAILED",
        attempts: 5,
        updatedAt: minutesBefore(120),
      }),
    ]);
  const lifecycle =
    createLifecycleCapture();
  let processCalls = 0;

  const result =
    await processPmsIngestRecovery(
      prisma,
      NOW,
      {
        maxAttempts: 5,
        processEvent: async () => {
          processCalls += 1;
        },
        recordState:
          lifecycle.recordState,
        resolveState:
          lifecycle.resolveState,
      }
    );

  assert.equal(processCalls, 0);
  assert.equal(result.attempted, 0);
  assert.equal(result.exhausted, 1);
  assert.equal(
    lifecycle.states.length,
    1
  );
  assert.equal(
    lifecycle.states[0]?.state,
    "EXHAUSTED"
  );
  assert.equal(
    lifecycle.states[0]?.attemptCount,
    5
  );
  assert.equal(
    lifecycle.states[0]
      ?.nextAttemptAt,
    null
  );
});
