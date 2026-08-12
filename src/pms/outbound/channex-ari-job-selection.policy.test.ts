import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_DEFAULT_SELECTION_LIMIT,
  CHANNEX_ARI_MAX_SELECTION_LIMIT,
  selectChannexAriDispatchJobs,
  type ChannexAriJobSelectionCandidate,
  type ChannexAriJobSelectionPropertyState,
} from "./channex-ari-job-selection.policy";
import { CHANNEX_ARI_MAX_ATTEMPTS } from "./channex-ari-lifecycle.policy";

const NOW = new Date("2026-07-28T12:00:00.000Z");

function candidate(
  overrides: Partial<ChannexAriJobSelectionCandidate> & { id: string }
): ChannexAriJobSelectionCandidate {
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
  overrides: Partial<ChannexAriJobSelectionCandidate> & { id: string }
): ChannexAriJobSelectionCandidate {
  return candidate({
    id: overrides.id,
    status: "PROCESSING",
    attemptCount: 1,
    nextAttemptAt: null,
    leaseToken: `lease-${overrides.id}`,
    leaseExpiresAt: new Date("2026-07-28T11:59:00.000Z"),
    ...overrides,
  });
}

function state(
  overrides: Partial<ChannexAriJobSelectionPropertyState> & {
    propertyId: string;
  }
): ChannexAriJobSelectionPropertyState {
  return {
    propertyId: overrides.propertyId,
    organizationId: "org-1",
    pausedUntil: null,
    availabilityNextAllowedAt: null,
    ratesNextAllowedAt: null,
    ...overrides,
  };
}

test("selects a due delivery for CLAIM with the default batch limit", () => {
  const result = selectChannexAriDispatchJobs({
    candidates: [candidate({ id: "delivery-1" })],
    now: NOW,
  });

  assert.equal(result.limit, CHANNEX_ARI_DEFAULT_SELECTION_LIMIT);
  assert.equal(result.inspectedCount, 1);
  assert.equal(result.selectedCount, 1);
  assert.deepEqual(result.actions, [
    {
      action: "CLAIM",
      deliveryId: "delivery-1",
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      partitionKey: "property-1:AVAILABILITY",
      readyAt: NOW,
      attemptCount: 0,
    },
  ]);
  assert.deepEqual(result.decisions, [
    {
      deliveryId: "delivery-1",
      partitionKey: "property-1:AVAILABILITY",
      action: "CLAIM",
      reason: null,
      nextEligibleAt: NOW,
    },
  ]);
});

test("prioritizes stale lease recovery before network dispatch regardless of queued age", () => {
  const result = selectChannexAriDispatchJobs({
    candidates: [
      candidate({
        id: "claim-old",
        propertyId: "property-claim",
        queuedAt: new Date("2026-07-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
      staleCandidate({
        id: "stale-new",
        propertyId: "property-stale",
        queuedAt: new Date("2026-07-28T11:59:30.000Z"),
        createdAt: new Date("2026-07-28T11:59:30.000Z"),
      }),
    ],
    now: NOW,
  });

  assert.deepEqual(
    result.actions.map((action) => [action.action, action.deliveryId]),
    [
      ["RECOVER_STALE_LEASE", "stale-new"],
      ["CLAIM", "claim-old"],
    ]
  );
});

test("selects stale final-attempt leases for recovery instead of dropping them", () => {
  const result = selectChannexAriDispatchJobs({
    candidates: [
      staleCandidate({
        id: "stale-final",
        attemptCount: CHANNEX_ARI_MAX_ATTEMPTS,
      }),
    ],
    now: NOW,
  });

  assert.equal(result.selectedCount, 1);
  assert.equal(result.actions[0].action, "RECOVER_STALE_LEASE");
  assert.equal(result.actions[0].attemptCount, CHANNEX_ARI_MAX_ATTEMPTS);
});

test("allows only one selected job per property and message kind", () => {
  const result = selectChannexAriDispatchJobs({
    candidates: [
      candidate({
        id: "delivery-later",
        nextAttemptAt: new Date("2026-07-28T11:59:00.000Z"),
        queuedAt: new Date("2026-07-28T11:49:00.000Z"),
      }),
      candidate({
        id: "delivery-earlier",
        nextAttemptAt: new Date("2026-07-28T11:58:00.000Z"),
        queuedAt: new Date("2026-07-28T11:55:00.000Z"),
      }),
    ],
    now: NOW,
  });

  assert.deepEqual(result.actions.map((action) => action.deliveryId), [
    "delivery-earlier",
  ]);
  assert.deepEqual(
    result.decisions.find(
      (decision) => decision.deliveryId === "delivery-later"
    ),
    {
      deliveryId: "delivery-later",
      partitionKey: "property-1:AVAILABILITY",
      action: null,
      reason: "PARTITION_ALREADY_SELECTED",
      nextEligibleAt: null,
    }
  );
});

test("a stale lease wins its partition over a due claim", () => {
  const result = selectChannexAriDispatchJobs({
    candidates: [
      candidate({ id: "claim-same-partition" }),
      staleCandidate({ id: "stale-same-partition" }),
    ],
    now: NOW,
  });

  assert.deepEqual(result.actions.map((action) => action.deliveryId), [
    "stale-same-partition",
  ]);
  assert.equal(
    result.decisions.find(
      (decision) => decision.deliveryId === "claim-same-partition"
    )?.reason,
    "PARTITION_ALREADY_SELECTED"
  );
});

test("keeps Availability and Rates & Restrictions as independent property lanes", () => {
  const result = selectChannexAriDispatchJobs({
    candidates: [
      candidate({ id: "availability" }),
      candidate({
        id: "rates",
        messageKind: "RATES_RESTRICTIONS",
      }),
    ],
    now: NOW,
  });

  assert.deepEqual(
    result.actions.map((action) => action.partitionKey),
    ["property-1:AVAILABILITY", "property-1:RATES_RESTRICTIONS"]
  );
});

test("applies pause and message-kind throttles to claims but never delays stale recovery", () => {
  const pausedUntil = new Date("2026-07-28T12:10:00.000Z");
  const availabilityNextAllowedAt = new Date("2026-07-28T12:05:00.000Z");
  const result = selectChannexAriDispatchJobs({
    candidates: [
      candidate({ id: "claim-paused" }),
      staleCandidate({
        id: "stale-paused",
        propertyId: "property-2",
      }),
      candidate({
        id: "rates-throttle-independent",
        propertyId: "property-3",
        messageKind: "RATES_RESTRICTIONS",
      }),
    ],
    propertyStates: [
      state({
        propertyId: "property-1",
        pausedUntil,
        availabilityNextAllowedAt,
      }),
      state({
        propertyId: "property-2",
        pausedUntil,
        availabilityNextAllowedAt,
      }),
      state({
        propertyId: "property-3",
        availabilityNextAllowedAt,
      }),
    ],
    now: NOW,
  });

  assert.deepEqual(
    result.actions.map((action) => action.deliveryId),
    ["stale-paused", "rates-throttle-independent"]
  );
  assert.deepEqual(
    result.decisions.find(
      (decision) => decision.deliveryId === "claim-paused"
    ),
    {
      deliveryId: "claim-paused",
      partitionKey: "property-1:AVAILABILITY",
      action: null,
      reason: "PROPERTY_PAUSED",
      nextEligibleAt: pausedUntil,
    }
  );
});

test("excludes active leases, future retries, exhausted non-processing and terminal statuses", () => {
  const activeLeaseExpiry = new Date("2026-07-28T12:01:00.000Z");
  const futureRetry = new Date("2026-07-28T12:02:00.000Z");
  const result = selectChannexAriDispatchJobs({
    candidates: [
      staleCandidate({
        id: "active-lease",
        leaseExpiresAt: activeLeaseExpiry,
      }),
      candidate({
        id: "future-retry",
        propertyId: "property-2",
        status: "RETRY_WAIT",
        attemptCount: 1,
        nextAttemptAt: futureRetry,
      }),
      candidate({
        id: "exhausted",
        propertyId: "property-3",
        attemptCount: CHANNEX_ARI_MAX_ATTEMPTS,
      }),
      candidate({
        id: "sent",
        propertyId: "property-4",
        status: "SENT",
        nextAttemptAt: null,
      }),
      candidate({
        id: "dead",
        propertyId: "property-5",
        status: "DEAD",
        nextAttemptAt: null,
      }),
      candidate({
        id: "superseded",
        propertyId: "property-6",
        status: "SUPERSEDED",
        nextAttemptAt: null,
      }),
    ],
    now: NOW,
  });

  assert.equal(result.selectedCount, 0);
  assert.deepEqual(
    Object.fromEntries(
      result.decisions.map((decision) => [decision.deliveryId, decision.reason])
    ),
    {
      "active-lease": "ACTIVE_LEASE",
      dead: "TERMINAL_STATUS",
      exhausted: "ATTEMPTS_EXHAUSTED",
      "future-retry": "NEXT_ATTEMPT_PENDING",
      sent: "TERMINAL_STATUS",
      superseded: "TERMINAL_STATUS",
    }
  );
});

test("uses deterministic ordering by priority, readyAt, queuedAt, createdAt and id", () => {
  const sharedReadyAt = new Date("2026-07-28T11:59:00.000Z");
  const sharedQueuedAt = new Date("2026-07-28T11:50:00.000Z");
  const sharedCreatedAt = new Date("2026-07-28T11:49:00.000Z");
  const result = selectChannexAriDispatchJobs({
    candidates: [
      candidate({
        id: "claim-z",
        propertyId: "property-z",
        nextAttemptAt: sharedReadyAt,
        queuedAt: sharedQueuedAt,
        createdAt: sharedCreatedAt,
      }),
      candidate({
        id: "claim-a",
        propertyId: "property-a",
        nextAttemptAt: sharedReadyAt,
        queuedAt: sharedQueuedAt,
        createdAt: sharedCreatedAt,
      }),
      candidate({
        id: "claim-created-earlier",
        propertyId: "property-created",
        nextAttemptAt: sharedReadyAt,
        queuedAt: sharedQueuedAt,
        createdAt: new Date("2026-07-28T11:48:00.000Z"),
      }),
      candidate({
        id: "claim-queued-earlier",
        propertyId: "property-queued",
        nextAttemptAt: sharedReadyAt,
        queuedAt: new Date("2026-07-28T11:40:00.000Z"),
        createdAt: new Date("2026-07-28T11:55:00.000Z"),
      }),
      candidate({
        id: "claim-ready-earlier",
        propertyId: "property-ready",
        nextAttemptAt: new Date("2026-07-28T11:58:00.000Z"),
      }),
    ],
    now: NOW,
  });

  assert.deepEqual(result.actions.map((action) => action.deliveryId), [
    "claim-ready-earlier",
    "claim-queued-earlier",
    "claim-created-earlier",
    "claim-a",
    "claim-z",
  ]);
  assert.deepEqual(
    result.decisions.map((decision) => decision.deliveryId),
    [
      "claim-a",
      "claim-created-earlier",
      "claim-queued-earlier",
      "claim-ready-earlier",
      "claim-z",
    ]
  );
});

test("enforces the batch limit after partition deduplication", () => {
  const result = selectChannexAriDispatchJobs({
    candidates: [
      candidate({ id: "delivery-1", propertyId: "property-1" }),
      candidate({ id: "delivery-2", propertyId: "property-2" }),
      candidate({ id: "delivery-3", propertyId: "property-3" }),
    ],
    now: NOW,
    limit: 2,
  });

  assert.equal(result.selectedCount, 2);
  assert.deepEqual(result.actions.map((action) => action.deliveryId), [
    "delivery-1",
    "delivery-2",
  ]);
  assert.equal(
    result.decisions.find((decision) => decision.deliveryId === "delivery-3")
      ?.reason,
    "BATCH_LIMIT"
  );
});

test("validates selection limits", () => {
  for (const limit of [0, -1, 1.5, CHANNEX_ARI_MAX_SELECTION_LIMIT + 1]) {
    assert.throws(
      () =>
        selectChannexAriDispatchJobs({
          candidates: [],
          now: NOW,
          limit,
        }),
      /CHANNEX_ARI_SELECTION_LIMIT_INVALID/
    );
  }
});

test("rejects duplicate delivery identities and conflicting property tenants", () => {
  assert.throws(
    () =>
      selectChannexAriDispatchJobs({
        candidates: [
          candidate({ id: "duplicate" }),
          candidate({ id: "duplicate", propertyId: "property-2" }),
        ],
        now: NOW,
      }),
    /CHANNEX_ARI_SELECTION_DUPLICATE_DELIVERY_ID/
  );

  assert.throws(
    () =>
      selectChannexAriDispatchJobs({
        candidates: [
          candidate({ id: "delivery-1" }),
          candidate({ id: "delivery-2", organizationId: "org-2" }),
        ],
        now: NOW,
      }),
    /CHANNEX_ARI_SELECTION_PROPERTY_TENANT_CONFLICT/
  );
});

test("rejects duplicate property states and cross-tenant state attachment", () => {
  assert.throws(
    () =>
      selectChannexAriDispatchJobs({
        candidates: [candidate({ id: "delivery-1" })],
        propertyStates: [
          state({ propertyId: "property-1" }),
          state({ propertyId: "property-1" }),
        ],
        now: NOW,
      }),
    /CHANNEX_ARI_SELECTION_DUPLICATE_PROPERTY_STATE/
  );

  assert.throws(
    () =>
      selectChannexAriDispatchJobs({
        candidates: [candidate({ id: "delivery-1" })],
        propertyStates: [
          state({ propertyId: "property-1", organizationId: "org-2" }),
        ],
        now: NOW,
      }),
    /CHANNEX_ARI_SELECTION_PROPERTY_STATE_TENANT_MISMATCH/
  );
});

test("rejects malformed lease identity through the dispatch contract", () => {
  assert.throws(
    () =>
      selectChannexAriDispatchJobs({
        candidates: [
          candidate({
            id: "broken-processing",
            status: "PROCESSING",
            attemptCount: 1,
            nextAttemptAt: null,
            leaseToken: "lease-only",
            leaseExpiresAt: null,
          }),
        ],
        now: NOW,
      }),
    /CHANNEX_ARI_LEASE_IDENTITY_INCOMPLETE/
  );
});
