import assert from "node:assert/strict";
import test from "node:test";
import type { ChannexBookingRevision } from "../adapters/types";
import {
  processChannexGlobalBookingRevisionFeed,
  type ChannexGlobalFeedTarget,
} from "./channex-global-feed.policy";

function revision(args: {
  revisionId: string;
  propertyId: string;
  insertedAt: string | null;
  bookingId?: string;
}): ChannexBookingRevision {
  const bookingId = args.bookingId ?? `booking-${args.revisionId}`;

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

function target(propertyId: string): ChannexGlobalFeedTarget {
  return {
    organizationId: `organization-${propertyId}`,
    propertyId: `pin-go-${propertyId}`,
    connectionId: `connection-${propertyId}`,
  };
}

function defaultLease() {
  let released = 0;

  return {
    acquireRunLease: async () => true,
    releaseRunLease: async () => {
      released += 1;
    },
    releasedCount: () => released,
  };
}

test("processes revisions from multiple sources in global oldest-first order and persists before ACK", async () => {
  const lease = defaultLease();
  const operations: string[] = [];

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      {
        sourceId: "source-a",
        fetchRevisions: async () => [
          revision({
            revisionId: "revision-3",
            propertyId: "property-a",
            insertedAt: "2026-07-01T03:00:00.000Z",
          }),
          revision({
            revisionId: "revision-1",
            propertyId: "property-a",
            insertedAt: "2026-07-01T01:00:00.000Z",
          }),
        ],
      },
      {
        sourceId: "source-b",
        fetchRevisions: async () => [
          revision({
            revisionId: "revision-2",
            propertyId: "property-b",
            insertedAt: "2026-07-01T02:00:00.000Z",
          }),
        ],
      },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async ({ revision }) => ({
      kind: "RESOLVED",
      target: target(revision.identity.propertyId),
    }),
    persistRevision: async ({ revision }) => {
      operations.push(`persist:${revision.identity.revisionId}`);
    },
    acknowledgeRevision: async ({ revision }) => {
      operations.push(`ack:${revision.identity.revisionId}`);
    },
  });

  assert.deepEqual(operations, [
    "persist:revision-1",
    "ack:revision-1",
    "persist:revision-2",
    "ack:revision-2",
    "persist:revision-3",
    "ack:revision-3",
  ]);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.sourceCount, 2);
  assert.equal(result.fetchedSourceCount, 2);
  assert.equal(result.failedSourceCount, 0);
  assert.equal(result.fetchedRevisionCount, 3);
  assert.equal(result.acknowledgedRevisionCount, 3);
  assert.equal(result.failedRevisionCount, 0);
  assert.equal(result.duplicateRevisionCount, 0);
  assert.equal(result.emptyFeed, false);
  assert.equal(lease.releasedCount(), 1);
});

test("does not ACK a revision when persistence fails and continues with later revisions", async () => {
  const lease = defaultLease();
  const persisted: string[] = [];
  const acknowledged: string[] = [];

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      {
        sourceId: "source-a",
        fetchRevisions: async () => [
          revision({
            revisionId: "revision-fails",
            propertyId: "property-a",
            insertedAt: "2026-07-01T01:00:00.000Z",
          }),
          revision({
            revisionId: "revision-succeeds",
            propertyId: "property-b",
            insertedAt: "2026-07-01T02:00:00.000Z",
          }),
        ],
      },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async ({ revision }) => ({
      kind: "RESOLVED",
      target: target(revision.identity.propertyId),
    }),
    persistRevision: async ({ revision }) => {
      persisted.push(revision.identity.revisionId);
      if (revision.identity.revisionId === "revision-fails") {
        throw new Error("database unavailable");
      }
    },
    acknowledgeRevision: async ({ revision }) => {
      acknowledged.push(revision.identity.revisionId);
    },
  });

  assert.deepEqual(persisted, ["revision-fails", "revision-succeeds"]);
  assert.deepEqual(acknowledged, ["revision-succeeds"]);
  assert.deepEqual(
    result.revisions.map((item) => [item.revisionId, item.outcome]),
    [
      ["revision-fails", "PERSISTENCE_FAILED"],
      ["revision-succeeds", "ACKNOWLEDGED"],
    ]
  );
  assert.equal(result.acknowledgedRevisionCount, 1);
  assert.equal(result.failedRevisionCount, 1);
  assert.equal(lease.releasedCount(), 1);
});

test("isolates unmapped, ambiguous, and failed target resolution without persistence or ACK", async () => {
  const lease = defaultLease();
  let persistenceCalls = 0;
  let acknowledgementCalls = 0;

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      {
        sourceId: "source-a",
        fetchRevisions: async () => [
          revision({
            revisionId: "revision-unmapped",
            propertyId: "property-unmapped",
            insertedAt: "2026-07-01T01:00:00.000Z",
          }),
          revision({
            revisionId: "revision-ambiguous",
            propertyId: "property-ambiguous",
            insertedAt: "2026-07-01T02:00:00.000Z",
          }),
          revision({
            revisionId: "revision-resolution-error",
            propertyId: "property-error",
            insertedAt: "2026-07-01T03:00:00.000Z",
          }),
        ],
      },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async ({ revision }) => {
      if (revision.identity.propertyId === "property-unmapped") {
        return { kind: "UNMAPPED" };
      }
      if (revision.identity.propertyId === "property-ambiguous") {
        return {
          kind: "AMBIGUOUS",
          candidateConnectionIds: ["connection-a", "connection-b"],
        };
      }
      throw new Error("target lookup failed");
    },
    persistRevision: async () => {
      persistenceCalls += 1;
    },
    acknowledgeRevision: async () => {
      acknowledgementCalls += 1;
    },
  });

  assert.equal(persistenceCalls, 0);
  assert.equal(acknowledgementCalls, 0);
  assert.deepEqual(
    result.revisions.map((item) => item.outcome),
    [
      "PROPERTY_UNMAPPED",
      "PROPERTY_AMBIGUOUS",
      "TARGET_RESOLUTION_FAILED",
    ]
  );
  assert.equal(result.failedRevisionCount, 3);
  assert.equal(lease.releasedCount(), 1);
});

test("isolates a failed credential source and processes revisions from healthy sources", async () => {
  const lease = defaultLease();
  const acknowledged: string[] = [];

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      {
        sourceId: "source-failed",
        fetchRevisions: async () => {
          throw new Error("invalid API key");
        },
      },
      {
        sourceId: "source-healthy",
        fetchRevisions: async () => [
          revision({
            revisionId: "revision-healthy",
            propertyId: "property-a",
            insertedAt: "2026-07-01T01:00:00.000Z",
          }),
        ],
      },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async ({ revision }) => ({
      kind: "RESOLVED",
      target: target(revision.identity.propertyId),
    }),
    persistRevision: async () => undefined,
    acknowledgeRevision: async ({ revision }) => {
      acknowledged.push(revision.identity.revisionId);
    },
  });

  assert.deepEqual(acknowledged, ["revision-healthy"]);
  assert.equal(result.fetchedSourceCount, 1);
  assert.equal(result.failedSourceCount, 1);
  assert.deepEqual(result.sourceErrors, [
    {
      sourceId: "source-failed",
      error: "invalid API key",
    },
  ]);
  assert.equal(result.acknowledgedRevisionCount, 1);
  assert.equal(lease.releasedCount(), 1);
});

test("deduplicates the same revision returned by multiple credential sources", async () => {
  const lease = defaultLease();
  const acknowledged: string[] = [];
  const duplicate = revision({
    revisionId: "revision-duplicate",
    propertyId: "property-a",
    insertedAt: "2026-07-01T01:00:00.000Z",
  });

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      {
        sourceId: "source-a",
        fetchRevisions: async () => [duplicate],
      },
      {
        sourceId: "source-b",
        fetchRevisions: async () => [duplicate],
      },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async ({ revision }) => ({
      kind: "RESOLVED",
      target: target(revision.identity.propertyId),
    }),
    persistRevision: async () => undefined,
    acknowledgeRevision: async ({ revision }) => {
      acknowledged.push(revision.identity.revisionId);
    },
  });

  assert.deepEqual(acknowledged, ["revision-duplicate"]);
  assert.equal(result.fetchedRevisionCount, 2);
  assert.equal(result.acknowledgedRevisionCount, 1);
  assert.equal(result.duplicateRevisionCount, 1);
  assert.deepEqual(
    result.revisions.map((item) => [item.sourceId, item.outcome]),
    [
      ["source-a", "ACKNOWLEDGED"],
      ["source-b", "DUPLICATE_SKIPPED"],
    ]
  );
  assert.equal(lease.releasedCount(), 1);
});

test("retries a duplicate revision from another source after persistence fails", async () => {
  const lease = defaultLease();
  const duplicate = revision({
    revisionId: "revision-persistence-fallback",
    propertyId: "property-a",
    insertedAt: "2026-07-01T01:00:00.000Z",
  });
  const operations: string[] = [];

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      { sourceId: "source-a", fetchRevisions: async () => [duplicate] },
      { sourceId: "source-b", fetchRevisions: async () => [duplicate] },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async ({ revision }) => ({
      kind: "RESOLVED",
      target: target(revision.identity.propertyId),
    }),
    persistRevision: async ({ sourceId }) => {
      operations.push(`persist:${sourceId}`);
      if (sourceId === "source-a") {
        throw new Error("source-a persistence unavailable");
      }
    },
    acknowledgeRevision: async ({ sourceId }) => {
      operations.push(`ack:${sourceId}`);
    },
  });

  assert.deepEqual(operations, [
    "persist:source-a",
    "persist:source-b",
    "ack:source-b",
  ]);
  assert.deepEqual(
    result.revisions.map((item) => [item.sourceId, item.outcome]),
    [
      ["source-a", "PERSISTENCE_FAILED"],
      ["source-b", "ACKNOWLEDGED"],
    ]
  );
  assert.equal(result.acknowledgedRevisionCount, 1);
  assert.equal(result.failedRevisionCount, 1);
  assert.equal(result.duplicateRevisionCount, 0);
  assert.equal(lease.releasedCount(), 1);
});

test("retries a duplicate revision from another source after acknowledgement fails", async () => {
  const lease = defaultLease();
  const duplicate = revision({
    revisionId: "revision-ack-fallback",
    propertyId: "property-a",
    insertedAt: "2026-07-01T01:00:00.000Z",
  });
  const operations: string[] = [];

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      { sourceId: "source-a", fetchRevisions: async () => [duplicate] },
      { sourceId: "source-b", fetchRevisions: async () => [duplicate] },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async ({ revision }) => ({
      kind: "RESOLVED",
      target: target(revision.identity.propertyId),
    }),
    persistRevision: async ({ sourceId }) => {
      operations.push(`persist:${sourceId}`);
    },
    acknowledgeRevision: async ({ sourceId }) => {
      operations.push(`ack:${sourceId}`);
      if (sourceId === "source-a") {
        throw new Error("source-a ACK unavailable");
      }
    },
  });

  assert.deepEqual(operations, [
    "persist:source-a",
    "ack:source-a",
    "persist:source-b",
    "ack:source-b",
  ]);
  assert.deepEqual(
    result.revisions.map((item) => [item.sourceId, item.outcome]),
    [
      ["source-a", "ACKNOWLEDGEMENT_FAILED"],
      ["source-b", "ACKNOWLEDGED"],
    ]
  );
  assert.equal(result.acknowledgedRevisionCount, 1);
  assert.equal(result.failedRevisionCount, 1);
  assert.equal(result.duplicateRevisionCount, 0);
  assert.equal(lease.releasedCount(), 1);
});

test("rejects an invalid insertedAt without resolving, persisting, or acknowledging", async () => {
  const lease = defaultLease();
  let resolutionCalls = 0;

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      {
        sourceId: "source-a",
        fetchRevisions: async () => [
          revision({
            revisionId: "revision-invalid-date",
            propertyId: "property-a",
            insertedAt: "not-a-date",
          }),
        ],
      },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async () => {
      resolutionCalls += 1;
      return { kind: "UNMAPPED" };
    },
    persistRevision: async () => {
      throw new Error("must not persist");
    },
    acknowledgeRevision: async () => {
      throw new Error("must not acknowledge");
    },
  });

  assert.equal(resolutionCalls, 0);
  assert.equal(result.revisions[0]?.outcome, "INVALID_INSERTED_AT");
  assert.equal(result.failedRevisionCount, 1);
  assert.equal(lease.releasedCount(), 1);
});

test("treats an empty global feed as a successful completed run", async () => {
  const lease = defaultLease();

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      { sourceId: "source-a", fetchRevisions: async () => [] },
      { sourceId: "source-b", fetchRevisions: async () => [] },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async () => {
      throw new Error("must not resolve");
    },
    persistRevision: async () => {
      throw new Error("must not persist");
    },
    acknowledgeRevision: async () => {
      throw new Error("must not acknowledge");
    },
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.emptyFeed, true);
  assert.equal(result.fetchedSourceCount, 2);
  assert.equal(result.fetchedRevisionCount, 0);
  assert.equal(result.failedRevisionCount, 0);
  assert.equal(lease.releasedCount(), 1);
});

test("skips a concurrent run before fetching any source", async () => {
  let fetchCalls = 0;
  let releaseCalls = 0;

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      {
        sourceId: "source-a",
        fetchRevisions: async () => {
          fetchCalls += 1;
          return [];
        },
      },
    ],
    acquireRunLease: async () => false,
    releaseRunLease: async () => {
      releaseCalls += 1;
    },
    resolveTarget: async () => ({ kind: "UNMAPPED" }),
    persistRevision: async () => undefined,
    acknowledgeRevision: async () => undefined,
  });

  assert.equal(result.status, "SKIPPED_CONCURRENT_RUN");
  assert.equal(fetchCalls, 0);
  assert.equal(releaseCalls, 0);
  assert.equal(result.emptyFeed, true);
});

test("records acknowledgement failure after successful persistence", async () => {
  const lease = defaultLease();
  const operations: string[] = [];

  const result = await processChannexGlobalBookingRevisionFeed({
    sources: [
      {
        sourceId: "source-a",
        fetchRevisions: async () => [
          revision({
            revisionId: "revision-ack-fails",
            propertyId: "property-a",
            insertedAt: "2026-07-01T01:00:00.000Z",
          }),
        ],
      },
    ],
    acquireRunLease: lease.acquireRunLease,
    releaseRunLease: lease.releaseRunLease,
    resolveTarget: async ({ revision }) => ({
      kind: "RESOLVED",
      target: target(revision.identity.propertyId),
    }),
    persistRevision: async ({ revision }) => {
      operations.push(`persist:${revision.identity.revisionId}`);
    },
    acknowledgeRevision: async ({ revision }) => {
      operations.push(`ack:${revision.identity.revisionId}`);
      throw new Error("ACK unavailable");
    },
  });

  assert.deepEqual(operations, [
    "persist:revision-ack-fails",
    "ack:revision-ack-fails",
  ]);
  assert.equal(result.revisions[0]?.outcome, "ACKNOWLEDGEMENT_FAILED");
  assert.equal(result.revisions[0]?.error, "ACK unavailable");
  assert.equal(result.acknowledgedRevisionCount, 0);
  assert.equal(result.failedRevisionCount, 1);
  assert.equal(lease.releasedCount(), 1);
});

test("releases the run lease when an unexpected malformed revision aborts the run", async () => {
  const lease = defaultLease();

  await assert.rejects(
    processChannexGlobalBookingRevisionFeed({
      sources: [
        {
          sourceId: "source-a",
          fetchRevisions: async () => [
            null as unknown as ChannexBookingRevision,
          ],
        },
      ],
      acquireRunLease: lease.acquireRunLease,
      releaseRunLease: lease.releaseRunLease,
      resolveTarget: async () => ({ kind: "UNMAPPED" }),
      persistRevision: async () => undefined,
      acknowledgeRevision: async () => undefined,
    })
  );

  assert.equal(lease.releasedCount(), 1);
});
