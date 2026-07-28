import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_DEFAULT_SELECTION_SCAN_MULTIPLIER,
  CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT,
  readChannexAriDispatchSelection,
} from "./channex-ari-job-selection.service";
import {
  CHANNEX_ARI_DEFAULT_SELECTION_LIMIT,
  CHANNEX_ARI_MAX_SELECTION_LIMIT,
} from "./channex-ari-job-selection.policy";
import { CHANNEX_ARI_MAX_ATTEMPTS } from "./channex-ari-lifecycle.policy";

const NOW = new Date("2026-07-28T12:00:00.000Z");

type CandidateRow = {
  id: string;
  organizationId: string;
  propertyId: string;
  messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
  status: "READY" | "PROCESSING" | "RETRY_WAIT";
  attemptCount: number;
  nextAttemptAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  queuedAt: Date;
  createdAt: Date;
};

type PropertyStateRow = {
  propertyId: string;
  organizationId: string;
  pausedUntil: Date | null;
  availabilityNextAllowedAt: Date | null;
  ratesNextAllowedAt: Date | null;
};

function claimCandidate(
  overrides: Partial<CandidateRow> & { id: string }
): CandidateRow {
  return {
    id: overrides.id,
    organizationId: "org-1",
    propertyId: "property-1",
    messageKind: "AVAILABILITY",
    status: "READY",
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
    queuedAt: new Date("2026-07-28T11:50:00.000Z"),
    createdAt: new Date("2026-07-28T11:49:00.000Z"),
    ...overrides,
  };
}

function staleCandidate(
  overrides: Partial<CandidateRow> & { id: string }
): CandidateRow {
  return claimCandidate({
    id: overrides.id,
    status: "PROCESSING",
    attemptCount: 1,
    nextAttemptAt: null,
    leaseToken: `lease-${overrides.id}`,
    leaseExpiresAt: new Date("2026-07-28T11:59:00.000Z"),
    ...overrides,
  });
}

function propertyState(
  overrides: Partial<PropertyStateRow> & { propertyId: string }
): PropertyStateRow {
  return {
    propertyId: overrides.propertyId,
    organizationId: "org-1",
    pausedUntil: null,
    availabilityNextAllowedAt: null,
    ratesNextAllowedAt: null,
    ...overrides,
  };
}

function createMockDb(input: {
  staleCandidates?: CandidateRow[];
  claimCandidates?: CandidateRow[];
  propertyStates?: PropertyStateRow[];
}) {
  const state = {
    deliveryQueries: [] as any[],
    propertyStateQueries: [] as any[],
  };

  return {
    db: {
      channexAriDelivery: {
        findMany: async (args: any) => {
          state.deliveryQueries.push(args);
          return args.where.status === "PROCESSING"
            ? input.staleCandidates ?? []
            : input.claimCandidates ?? [];
        },
      },
      channexAriPropertyState: {
        findMany: async (args: any) => {
          state.propertyStateQueries.push(args);
          return input.propertyStates ?? [];
        },
      },
    },
    state,
  };
}

test("queries stale and claim candidates with certified predicates and ordering", async () => {
  const mock = createMockDb({
    staleCandidates: [staleCandidate({ id: "stale-1" })],
    claimCandidates: [
      claimCandidate({
        id: "claim-1",
        propertyId: "property-2",
        messageKind: "RATES_RESTRICTIONS",
      }),
    ],
    propertyStates: [
      propertyState({ propertyId: "property-1" }),
      propertyState({ propertyId: "property-2" }),
    ],
  });

  const result = await readChannexAriDispatchSelection(mock.db as any, {
    now: NOW,
    limit: 2,
    candidateScanLimit: 20,
  });

  assert.equal(mock.state.deliveryQueries.length, 2);
  assert.deepEqual(mock.state.deliveryQueries[0].where, {
    status: "PROCESSING",
    leaseToken: { not: null },
    leaseExpiresAt: { lte: NOW },
  });
  assert.deepEqual(mock.state.deliveryQueries[0].orderBy, [
    { leaseExpiresAt: "asc" },
    { queuedAt: "asc" },
    { createdAt: "asc" },
    { id: "asc" },
  ]);
  assert.equal(mock.state.deliveryQueries[0].take, 20);

  assert.deepEqual(mock.state.deliveryQueries[1].where, {
    status: { in: ["READY", "RETRY_WAIT"] },
    attemptCount: { lt: CHANNEX_ARI_MAX_ATTEMPTS },
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: NOW } }],
  });
  assert.deepEqual(mock.state.deliveryQueries[1].orderBy, [
    { nextAttemptAt: "asc" },
    { queuedAt: "asc" },
    { createdAt: "asc" },
    { id: "asc" },
  ]);
  assert.equal(mock.state.deliveryQueries[1].take, 20);

  assert.deepEqual(mock.state.propertyStateQueries, [
    {
      where: {
        propertyId: { in: ["property-1", "property-2"] },
      },
      orderBy: [{ propertyId: "asc" }],
      select: {
        propertyId: true,
        organizationId: true,
        pausedUntil: true,
        availabilityNextAllowedAt: true,
        ratesNextAllowedAt: true,
      },
    },
  ]);

  assert.deepEqual(
    result.actions.map((action) => [action.action, action.deliveryId]),
    [
      ["RECOVER_STALE_LEASE", "stale-1"],
      ["CLAIM", "claim-1"],
    ]
  );
  assert.deepEqual(result.query, {
    candidateScanLimit: 20,
    staleCandidateCount: 1,
    claimCandidateCount: 1,
    uniqueCandidateCount: 2,
    propertyStateCount: 2,
  });
});

test("uses the default selection and scan limits", async () => {
  const mock = createMockDb({});

  const result = await readChannexAriDispatchSelection(mock.db as any, {
    now: NOW,
  });

  assert.equal(result.limit, CHANNEX_ARI_DEFAULT_SELECTION_LIMIT);
  assert.equal(
    result.query.candidateScanLimit,
    CHANNEX_ARI_DEFAULT_SELECTION_LIMIT *
      CHANNEX_ARI_DEFAULT_SELECTION_SCAN_MULTIPLIER
  );
  assert.equal(
    mock.state.deliveryQueries[0].take,
    CHANNEX_ARI_DEFAULT_SELECTION_LIMIT *
      CHANNEX_ARI_DEFAULT_SELECTION_SCAN_MULTIPLIER
  );
  assert.equal(mock.state.deliveryQueries[1].take, mock.state.deliveryQueries[0].take);
});

test("caps the default scan limit at the certified maximum", async () => {
  const mock = createMockDb({});

  const result = await readChannexAriDispatchSelection(mock.db as any, {
    now: NOW,
    limit: CHANNEX_ARI_MAX_SELECTION_LIMIT,
  });

  assert.equal(result.query.candidateScanLimit, CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT);
});

test("deduplicates candidates returned by both database lanes", async () => {
  const duplicate = staleCandidate({ id: "delivery-1" });
  const mock = createMockDb({
    staleCandidates: [duplicate],
    claimCandidates: [duplicate],
    propertyStates: [propertyState({ propertyId: "property-1" })],
  });

  const result = await readChannexAriDispatchSelection(mock.db as any, {
    now: NOW,
  });

  assert.equal(result.query.staleCandidateCount, 1);
  assert.equal(result.query.claimCandidateCount, 1);
  assert.equal(result.query.uniqueCandidateCount, 1);
  assert.equal(result.inspectedCount, 1);
  assert.equal(result.selectedCount, 1);
  assert.equal(result.actions[0].action, "RECOVER_STALE_LEASE");
});

test("does not query property state when there are no candidates", async () => {
  const mock = createMockDb({});

  const result = await readChannexAriDispatchSelection(mock.db as any, {
    now: NOW,
  });

  assert.equal(mock.state.propertyStateQueries.length, 0);
  assert.equal(result.selectedCount, 0);
  assert.deepEqual(result.query, {
    candidateScanLimit: 250,
    staleCandidateCount: 0,
    claimCandidateCount: 0,
    uniqueCandidateCount: 0,
    propertyStateCount: 0,
  });
});

test("loads each property state once for multiple message-kind lanes", async () => {
  const mock = createMockDb({
    claimCandidates: [
      claimCandidate({ id: "availability" }),
      claimCandidate({
        id: "rates",
        messageKind: "RATES_RESTRICTIONS",
      }),
    ],
    propertyStates: [propertyState({ propertyId: "property-1" })],
  });

  const result = await readChannexAriDispatchSelection(mock.db as any, {
    now: NOW,
  });

  assert.deepEqual(mock.state.propertyStateQueries[0].where, {
    propertyId: { in: ["property-1"] },
  });
  assert.equal(result.query.propertyStateCount, 1);
  assert.equal(result.selectedCount, 2);
});

test("applies durable pause and throttle state through the pure selector", async () => {
  const pausedUntil = new Date("2026-07-28T12:10:00.000Z");
  const ratesNextAllowedAt = new Date("2026-07-28T12:05:00.000Z");
  const mock = createMockDb({
    claimCandidates: [
      claimCandidate({ id: "availability" }),
      claimCandidate({
        id: "rates",
        propertyId: "property-2",
        messageKind: "RATES_RESTRICTIONS",
      }),
    ],
    propertyStates: [
      propertyState({ propertyId: "property-1", pausedUntil }),
      propertyState({ propertyId: "property-2", ratesNextAllowedAt }),
    ],
  });

  const result = await readChannexAriDispatchSelection(mock.db as any, {
    now: NOW,
  });

  assert.equal(result.selectedCount, 0);
  assert.deepEqual(
    Object.fromEntries(
      result.decisions.map((decision) => [decision.deliveryId, decision.reason])
    ),
    {
      availability: "PROPERTY_PAUSED",
      rates: "KIND_THROTTLED",
    }
  );
});

test("passes the requested batch limit to deterministic selection", async () => {
  const mock = createMockDb({
    claimCandidates: [
      claimCandidate({ id: "delivery-1", propertyId: "property-1" }),
      claimCandidate({ id: "delivery-2", propertyId: "property-2" }),
      claimCandidate({ id: "delivery-3", propertyId: "property-3" }),
    ],
  });

  const result = await readChannexAriDispatchSelection(mock.db as any, {
    now: NOW,
    limit: 2,
    candidateScanLimit: 30,
  });

  assert.equal(result.limit, 2);
  assert.equal(result.selectedCount, 2);
  assert.equal(
    result.decisions.find((decision) => decision.deliveryId === "delivery-3")
      ?.reason,
    "BATCH_LIMIT"
  );
});

test("validates selection and candidate scan limits before querying Prisma", async () => {
  for (const limit of [0, -1, 1.5, CHANNEX_ARI_MAX_SELECTION_LIMIT + 1]) {
    const mock = createMockDb({});

    await assert.rejects(
      () =>
        readChannexAriDispatchSelection(mock.db as any, {
          now: NOW,
          limit,
        }),
      /CHANNEX_ARI_SELECTION_LIMIT_INVALID/
    );
    assert.equal(mock.state.deliveryQueries.length, 0);
  }

  for (const candidateScanLimit of [
    1,
    9,
    10.5,
    CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT + 1,
  ]) {
    const mock = createMockDb({});

    await assert.rejects(
      () =>
        readChannexAriDispatchSelection(mock.db as any, {
          now: NOW,
          limit: 10,
          candidateScanLimit,
        }),
      /CHANNEX_ARI_SELECTION_SCAN_LIMIT_INVALID/
    );
    assert.equal(mock.state.deliveryQueries.length, 0);
  }
});

test("rejects an invalid selection timestamp before querying Prisma", async () => {
  const mock = createMockDb({});

  await assert.rejects(
    () =>
      readChannexAriDispatchSelection(mock.db as any, {
        now: new Date("invalid"),
      }),
    /CHANNEX_ARI_SELECTION_NOW_INVALID/
  );
  assert.equal(mock.state.deliveryQueries.length, 0);
});
