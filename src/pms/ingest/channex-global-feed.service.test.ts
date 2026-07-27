import assert from "node:assert/strict";
import test from "node:test";
import type { ChannexBookingRevision } from "../adapters/types";
import {
  executeChannexGlobalFeedOnce,
  type ActiveChannexConnection,
  type ChannexGlobalFeedExecutionDependencies,
} from "./channex-global-feed.service";

const defaultConfig = {
  pollMs: 60_000,
  leaseMs: 600_000,
  maxSourcesPerRun: 25,
  maxRevisionsPerRun: 500,
};

function revision(args: {
  revisionId: string;
  propertyId: string;
  insertedAt: string;
}): ChannexBookingRevision {
  const bookingId = `booking-${args.revisionId}`;

  return {
    identity: {
      revisionId: args.revisionId,
      bookingId,
      propertyId: args.propertyId,
      insertedAt: args.insertedAt,
    },
    reservation: {
      provider: "CHANNEX",
      externalReservationId: bookingId,
      externalListingId: `room-${args.propertyId}`,
      status: "CONFIRMED",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      raw: {},
    },
    raw: {},
  };
}

function connection(args: {
  id: string;
  organizationId?: string;
  credentialsEncrypted: string | null;
  mappings: Array<{
    propertyId: string;
    channexPropertyId: string;
  }>;
}): ActiveChannexConnection {
  return {
    id: args.id,
    organizationId: args.organizationId ?? `organization-${args.id}`,
    credentialsEncrypted: args.credentialsEncrypted,
    metadata: {},
    listings: args.mappings.map((mapping) => ({
      propertyId: mapping.propertyId,
      metadata: {
        channexPropertyId: mapping.channexPropertyId,
      },
    })),
  };
}

function dependencies(args: {
  acquire?: () => Promise<boolean>;
  release?: () => Promise<void>;
  connections?: () => Promise<ActiveChannexConnection[]>;
  fetch?: ChannexGlobalFeedExecutionDependencies["fetchBookingRevisionFeed"];
  persist?: ChannexGlobalFeedExecutionDependencies["persistBookingRevision"];
  acknowledge?: ChannexGlobalFeedExecutionDependencies["acknowledgeBookingRevision"];
}): ChannexGlobalFeedExecutionDependencies {
  return {
    acquireRunLease: async () => (args.acquire ? args.acquire() : true),
    releaseRunLease: async () => {
      if (args.release) await args.release();
    },
    loadActiveConnections: async () =>
      args.connections ? args.connections() : [],
    fetchBookingRevisionFeed: async (input) =>
      args.fetch ? args.fetch(input) : [],
    persistBookingRevision: async (input) => {
      if (args.persist) return args.persist(input);

      return {
        correlationId: input.correlationId,
        organizationId: input.organizationId,
        propertyId: `pin-go-${input.revision.identity.propertyId}`,
        reservationId: `reservation-${input.revision.identity.revisionId}`,
        revision: input.revision,
      };
    },
    acknowledgeBookingRevision: async (input) => {
      if (args.acknowledge) await args.acknowledge(input);
    },
  };
}

test("skips a concurrent run before loading connections", async () => {
  let loaded = 0;
  let released = 0;

  const result = await executeChannexGlobalFeedOnce({
    config: defaultConfig,
    dependencies: dependencies({
      acquire: async () => false,
      release: async () => {
        released += 1;
      },
      connections: async () => {
        loaded += 1;
        return [];
      },
    }),
  });

  assert.equal(result.status, "SKIPPED_CONCURRENT_RUN");
  assert.equal(loaded, 0);
  assert.equal(released, 0);
});

test("groups connections with the same credentials into one Feed source", async () => {
  const operations: string[] = [];
  let fetchCalls = 0;
  let releaseCalls = 0;
  const connections = [
    connection({
      id: "connection-a",
      credentialsEncrypted: "shared-credentials",
      mappings: [
        { propertyId: "pin-go-a", channexPropertyId: "channex-a" },
      ],
    }),
    connection({
      id: "connection-b",
      credentialsEncrypted: "shared-credentials",
      mappings: [
        { propertyId: "pin-go-b", channexPropertyId: "channex-b" },
      ],
    }),
  ];

  const result = await executeChannexGlobalFeedOnce({
    config: defaultConfig,
    dependencies: dependencies({
      release: async () => {
        releaseCalls += 1;
      },
      connections: async () => connections,
      fetch: async ({ connection: sourceConnection }) => {
        fetchCalls += 1;
        assert.equal(sourceConnection.id, "connection-a");
        return [
          revision({
            revisionId: "revision-a",
            propertyId: "channex-a",
            insertedAt: "2026-07-01T01:00:00.000Z",
          }),
          revision({
            revisionId: "revision-b",
            propertyId: "channex-b",
            insertedAt: "2026-07-01T02:00:00.000Z",
          }),
        ];
      },
      persist: async (input) => {
        operations.push(
          `persist:${input.connectionId}:${input.revision.identity.revisionId}`
        );
        return {
          correlationId: input.correlationId,
          organizationId: input.organizationId,
          propertyId:
            input.revision.identity.propertyId === "channex-a"
              ? "pin-go-a"
              : "pin-go-b",
          reservationId: `reservation-${input.revision.identity.revisionId}`,
          revision: input.revision,
        };
      },
      acknowledge: async ({ persisted }) => {
        operations.push(`ack:${persisted.revision.identity.revisionId}`);
      },
    }),
  });

  assert.equal(fetchCalls, 1);
  assert.equal(result.connectionCount, 2);
  assert.equal(result.credentialSourceCount, 1);
  assert.equal(result.acknowledgedRevisionCount, 2);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(operations, [
    "persist:connection-a:revision-a",
    "ack:revision-a",
    "persist:connection-b:revision-b",
    "ack:revision-b",
  ]);
});

test("isolates identical Channex property IDs between credential sources", async () => {
  const persistedTargets: string[] = [];
  const connections = [
    connection({
      id: "connection-a",
      credentialsEncrypted: "credentials-a",
      mappings: [
        { propertyId: "pin-go-a", channexPropertyId: "shared-property" },
      ],
    }),
    connection({
      id: "connection-b",
      credentialsEncrypted: "credentials-b",
      mappings: [
        { propertyId: "pin-go-b", channexPropertyId: "shared-property" },
      ],
    }),
  ];

  const result = await executeChannexGlobalFeedOnce({
    config: defaultConfig,
    dependencies: dependencies({
      connections: async () => connections,
      fetch: async ({ connection: sourceConnection }) => [
        revision({
          revisionId: `revision-${sourceConnection.id}`,
          propertyId: "shared-property",
          insertedAt:
            sourceConnection.id === "connection-a"
              ? "2026-07-01T01:00:00.000Z"
              : "2026-07-01T02:00:00.000Z",
        }),
      ],
      persist: async (input) => {
        const propertyId =
          input.connectionId === "connection-a" ? "pin-go-a" : "pin-go-b";
        persistedTargets.push(`${input.connectionId}:${propertyId}`);
        return {
          correlationId: input.correlationId,
          organizationId: input.organizationId,
          propertyId,
          reservationId: `reservation-${input.revision.identity.revisionId}`,
          revision: input.revision,
        };
      },
    }),
  });

  assert.equal(result.credentialSourceCount, 2);
  assert.equal(result.acknowledgedRevisionCount, 2);
  assert.deepEqual(persistedTargets.sort(), [
    "connection-a:pin-go-a",
    "connection-b:pin-go-b",
  ]);
});

test("marks duplicate mappings inside the same credential source as ambiguous", async () => {
  let persistCalls = 0;
  let acknowledgeCalls = 0;
  const connections = [
    connection({
      id: "connection-a",
      credentialsEncrypted: "shared-credentials",
      mappings: [
        { propertyId: "pin-go-a", channexPropertyId: "shared-property" },
      ],
    }),
    connection({
      id: "connection-b",
      credentialsEncrypted: "shared-credentials",
      mappings: [
        { propertyId: "pin-go-b", channexPropertyId: "shared-property" },
      ],
    }),
  ];

  const result = await executeChannexGlobalFeedOnce({
    config: defaultConfig,
    dependencies: dependencies({
      connections: async () => connections,
      fetch: async () => [
        revision({
          revisionId: "revision-ambiguous",
          propertyId: "shared-property",
          insertedAt: "2026-07-01T01:00:00.000Z",
        }),
      ],
      persist: async (input) => {
        persistCalls += 1;
        return {
          correlationId: input.correlationId,
          organizationId: input.organizationId,
          propertyId: "unexpected",
          reservationId: null,
          revision: input.revision,
        };
      },
      acknowledge: async () => {
        acknowledgeCalls += 1;
      },
    }),
  });

  assert.equal(persistCalls, 0);
  assert.equal(acknowledgeCalls, 0);
  assert.equal(result.failedRevisionCount, 1);
  assert.equal(result.revisions[0]?.outcome, "PROPERTY_AMBIGUOUS");
  assert.equal(result.revisions[0]?.error, "connection-a,connection-b");
});

test("selects the oldest revisions globally and reports truncation", async () => {
  const persisted: string[] = [];
  const connections = [
    connection({
      id: "connection-a",
      credentialsEncrypted: "credentials-a",
      mappings: [
        { propertyId: "pin-go-a", channexPropertyId: "channex-a" },
      ],
    }),
    connection({
      id: "connection-b",
      credentialsEncrypted: "credentials-b",
      mappings: [
        { propertyId: "pin-go-b", channexPropertyId: "channex-b" },
      ],
    }),
  ];

  const result = await executeChannexGlobalFeedOnce({
    config: {
      ...defaultConfig,
      maxRevisionsPerRun: 2,
    },
    dependencies: dependencies({
      connections: async () => connections,
      fetch: async ({ connection: sourceConnection }) =>
        sourceConnection.id === "connection-a"
          ? [
              revision({
                revisionId: "revision-3",
                propertyId: "channex-a",
                insertedAt: "2026-07-01T03:00:00.000Z",
              }),
              revision({
                revisionId: "revision-1",
                propertyId: "channex-a",
                insertedAt: "2026-07-01T01:00:00.000Z",
              }),
            ]
          : [
              revision({
                revisionId: "revision-2",
                propertyId: "channex-b",
                insertedAt: "2026-07-01T02:00:00.000Z",
              }),
            ],
      persist: async (input) => {
        persisted.push(input.revision.identity.revisionId);
        return {
          correlationId: input.correlationId,
          organizationId: input.organizationId,
          propertyId:
            input.revision.identity.propertyId === "channex-a"
              ? "pin-go-a"
              : "pin-go-b",
          reservationId: `reservation-${input.revision.identity.revisionId}`,
          revision: input.revision,
        };
      },
    }),
  });

  assert.deepEqual(persisted, ["revision-1", "revision-2"]);
  assert.equal(result.discoveredRevisionCount, 3);
  assert.equal(result.selectedRevisionCount, 2);
  assert.equal(result.truncatedRevisionCount, 1);
  assert.equal(result.fetchedRevisionCount, 2);
});

test("preserves all credential copies inside a one-revision logical budget", async () => {
  const operations: string[] = [];
  let persistenceAttempts = 0;
  const connections = [
    connection({
      id: "connection-a",
      credentialsEncrypted: "credentials-a",
      mappings: [
        { propertyId: "pin-go-a", channexPropertyId: "shared-property" },
      ],
    }),
    connection({
      id: "connection-b",
      credentialsEncrypted: "credentials-b",
      mappings: [
        { propertyId: "pin-go-b", channexPropertyId: "shared-property" },
      ],
    }),
  ];

  const result = await executeChannexGlobalFeedOnce({
    config: {
      ...defaultConfig,
      maxRevisionsPerRun: 1,
    },
    dependencies: dependencies({
      connections: async () => connections,
      fetch: async () => [
        revision({
          revisionId: "revision-fallback",
          propertyId: "shared-property",
          insertedAt: "2026-07-01T01:00:00.000Z",
        }),
      ],
      persist: async (input) => {
        persistenceAttempts += 1;
        operations.push(`persist:${input.connectionId}`);

        if (persistenceAttempts === 1) {
          throw new Error("first credential source persistence failed");
        }

        return {
          correlationId: input.correlationId,
          organizationId: input.organizationId,
          propertyId:
            input.connectionId === "connection-a" ? "pin-go-a" : "pin-go-b",
          reservationId: "reservation-fallback",
          revision: input.revision,
        };
      },
      acknowledge: async ({ connection: sourceConnection }) => {
        operations.push(`ack:${sourceConnection.id}`);
      },
    }),
  });

  assert.equal(result.discoveredRevisionCount, 2);
  assert.equal(result.selectedRevisionCount, 2);
  assert.equal(result.truncatedRevisionCount, 0);
  assert.equal(result.fetchedRevisionCount, 2);
  assert.equal(result.acknowledgedRevisionCount, 1);
  assert.equal(result.failedRevisionCount, 1);
  assert.equal(result.duplicateRevisionCount, 0);
  assert.deepEqual(
    result.revisions.map((item) => item.outcome),
    ["PERSISTENCE_FAILED", "ACKNOWLEDGED"]
  );
  assert.equal(operations.length, 3);
  assert.match(operations[0] ?? "", /^persist:connection-[ab]$/);
  assert.match(operations[1] ?? "", /^persist:connection-[ab]$/);
  assert.notEqual(operations[0], operations[1]);
  assert.equal(
    operations[2],
    (operations[1] ?? "").replace("persist:", "ack:")
  );
});

test("isolates a failed credential source and processes a healthy source", async () => {
  const connections = [
    connection({
      id: "connection-failed",
      credentialsEncrypted: "credentials-failed",
      mappings: [
        { propertyId: "pin-go-failed", channexPropertyId: "failed-property" },
      ],
    }),
    connection({
      id: "connection-healthy",
      credentialsEncrypted: "credentials-healthy",
      mappings: [
        { propertyId: "pin-go-healthy", channexPropertyId: "healthy-property" },
      ],
    }),
  ];

  const result = await executeChannexGlobalFeedOnce({
    config: defaultConfig,
    dependencies: dependencies({
      connections: async () => connections,
      fetch: async ({ connection: sourceConnection }) => {
        if (sourceConnection.id === "connection-failed") {
          throw new Error("invalid API key");
        }

        return [
          revision({
            revisionId: "revision-healthy",
            propertyId: "healthy-property",
            insertedAt: "2026-07-01T01:00:00.000Z",
          }),
        ];
      },
      persist: async (input) => ({
        correlationId: input.correlationId,
        organizationId: input.organizationId,
        propertyId: "pin-go-healthy",
        reservationId: "reservation-healthy",
        revision: input.revision,
      }),
    }),
  });

  assert.equal(result.failedSourceCount, 1);
  assert.equal(result.acknowledgedRevisionCount, 1);
  assert.equal(result.sourceErrors[0]?.error, "invalid API key");
});

test("releases the lease when the source limit is exceeded", async () => {
  let releaseCalls = 0;

  await assert.rejects(
    executeChannexGlobalFeedOnce({
      config: {
        ...defaultConfig,
        maxSourcesPerRun: 1,
      },
      dependencies: dependencies({
        release: async () => {
          releaseCalls += 1;
        },
        connections: async () => [
          connection({
            id: "connection-a",
            credentialsEncrypted: "credentials-a",
            mappings: [],
          }),
          connection({
            id: "connection-b",
            credentialsEncrypted: "credentials-b",
            mappings: [],
          }),
        ],
      }),
    }),
    /CHANNEX_GLOBAL_FEED_SOURCE_LIMIT_EXCEEDED/
  );

  assert.equal(releaseCalls, 1);
});

test("does not ACK when persistence resolves to a different target", async () => {
  let acknowledgeCalls = 0;

  const result = await executeChannexGlobalFeedOnce({
    config: defaultConfig,
    dependencies: dependencies({
      connections: async () => [
        connection({
          id: "connection-a",
          credentialsEncrypted: "credentials-a",
          mappings: [
            { propertyId: "pin-go-a", channexPropertyId: "channex-a" },
          ],
        }),
      ],
      fetch: async () => [
        revision({
          revisionId: "revision-target-changed",
          propertyId: "channex-a",
          insertedAt: "2026-07-01T01:00:00.000Z",
        }),
      ],
      persist: async (input) => ({
        correlationId: input.correlationId,
        organizationId: input.organizationId,
        propertyId: "different-property",
        reservationId: "reservation-a",
        revision: input.revision,
      }),
      acknowledge: async () => {
        acknowledgeCalls += 1;
      },
    }),
  });

  assert.equal(acknowledgeCalls, 0);
  assert.equal(result.revisions[0]?.outcome, "PERSISTENCE_FAILED");
  assert.match(
    result.revisions[0]?.error ?? "",
    /CHANNEX_GLOBAL_FEED_TARGET_CHANGED/
  );
});
