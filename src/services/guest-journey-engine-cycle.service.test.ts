import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyState,
} from "@prisma/client";
import type {
  PrismaClient,
} from "@prisma/client";

import {
  runGuestJourneyEngineCycle,
} from "./guest-journey-engine-cycle.service";
import type {
  GuestJourneyInternalReconcileConfig,
} from "./guest-journey-internal-reconcile.config";

function config(
  overrides:
    Partial<
      GuestJourneyInternalReconcileConfig
    > = {}
): GuestJourneyInternalReconcileConfig {
  return {
    enabled: true,
    batchSize: 2,
    horizonDays: 90,
    lookbackDays: 7,
    organizationIds: [
      "organization-1",
    ],
    propertyIds: ["property-2"],
    ...overrides,
  };
}

function candidate(
  id: string,
  propertyId: string,
  organizationId: string
) {
  return {
    id,
    propertyId,
    property: {
      organizationId,
    },
  };
}

test(
  "performs no database read when the rollback flag is disabled",
  async () => {
    let reads = 0;
    const prisma = {
      reservation: {
        findMany: async () => {
          reads += 1;
          return [];
        },
      },
    } as unknown as PrismaClient;

    const metrics =
      await runGuestJourneyEngineCycle(
        prisma,
        config({
          enabled: false,
          organizationIds: [],
          propertyIds: [],
        })
      );

    assert.equal(reads, 0);
    assert.equal(metrics.enabled, false);
    assert.equal(metrics.selected, 0);
    assert.equal(
      metrics.coordinationIntentWrites,
      0
    );
    assert.equal(
      metrics.ownerEngineExecutions,
      0
    );
  }
);

test(
  "selects a bounded tenant-scoped batch and passes exact scope to every reconciliation",
  async () => {
    const queryCalls: unknown[] = [];
    const reconcileCalls: Array<{
      id: string;
      scope: unknown;
    }> = [];
    const candidates = [
      candidate(
        "reservation-1",
        "property-1",
        "organization-1"
      ),
      candidate(
        "reservation-2",
        "property-2",
        "organization-2"
      ),
    ];
    const prisma = {
      reservation: {
        findMany: async (args: unknown) => {
          queryCalls.push(args);
          return candidates;
        },
      },
    } as unknown as PrismaClient;

    const metrics =
      await runGuestJourneyEngineCycle(
        prisma,
        config(),
        {
          now: new Date(
            "2026-08-10T14:30:00.000Z"
          ),
          cursor: "reservation-0",
          reconcile: (async (
            _prisma: PrismaClient,
            id: string,
            options: {
              scope: unknown;
            }
          ) => {
            reconcileCalls.push({
              id,
              scope: options.scope,
            });
            return {
              reservationId: id,
              journeyId: `journey-${id}`,
              evaluation: {},
              initialPersistedState:
                GuestJourneyState
                  .RESERVATION_CONFIRMED,
              finalPersistedState:
                GuestJourneyState
                  .VERIFICATION_PENDING,
              actions: [
                {
                  code:
                    id === "reservation-1"
                      ? "ADVANCE_CANONICAL_TRANSITION"
                      : "NO_ACTION",
                  detail: "test",
                },
              ],
              proposedCoordinationIntentCount:
                2,
              coordinationIntentWrites: 0,
              operationalIssueWrites: 0,
            };
          }) as never,
        }
      );

    assert.equal(queryCalls.length, 1);
    const query = queryCalls[0] as {
      take: number;
      cursor: { id: string };
      skip: number;
      where: unknown;
    };
    assert.equal(query.take, 2);
    assert.deepEqual(query.cursor, {
      id: "reservation-0",
    });
    assert.equal(query.skip, 1);
    assert.match(
      JSON.stringify(query.where),
      /organization-1/
    );
    assert.match(
      JSON.stringify(query.where),
      /property-2/
    );
    assert.deepEqual(reconcileCalls, [
      {
        id: "reservation-1",
        scope: {
          organizationId:
            "organization-1",
          propertyId: "property-1",
        },
      },
      {
        id: "reservation-2",
        scope: {
          organizationId:
            "organization-2",
          propertyId: "property-2",
        },
      },
    ]);
    assert.equal(metrics.selected, 2);
    assert.equal(metrics.reconciled, 2);
    assert.equal(metrics.transitions, 1);
    assert.equal(metrics.noAction, 1);
    assert.equal(
      metrics
        .proposedCoordinationIntentsObserved,
      4
    );
    assert.equal(
      metrics.coordinationIntentWrites,
      0
    );
    assert.equal(
      metrics.operationalIssueWrites,
      0
    );
    assert.equal(
      metrics.ownerEngineExecutions,
      0
    );
    assert.equal(
      metrics.nextCursor,
      "reservation-2"
    );
  }
);

test(
  "isolates a reservation failure and continues the bounded cycle",
  async () => {
    const prisma = {
      reservation: {
        findMany: async () => [
          candidate(
            "reservation-fail",
            "property-1",
            "organization-1"
          ),
          candidate(
            "reservation-ok",
            "property-1",
            "organization-1"
          ),
        ],
      },
    } as unknown as PrismaClient;

    const metrics =
      await runGuestJourneyEngineCycle(
        prisma,
        config(),
        {
          reconcile: (async (
            _prisma: PrismaClient,
            id: string
          ) => {
            if (id === "reservation-fail") {
              throw new Error(
                "GUEST_JOURNEY_TEST_FAILURE:boom"
              );
            }

            return {
              reservationId: id,
              journeyId: "journey-ok",
              evaluation: {},
              initialPersistedState:
                GuestJourneyState
                  .RESERVATION_CONFIRMED,
              finalPersistedState:
                GuestJourneyState
                  .RESERVATION_CONFIRMED,
              actions: [
                {
                  code: "NO_ACTION",
                  detail: "aligned",
                },
              ],
              proposedCoordinationIntentCount:
                0,
              coordinationIntentWrites: 0,
              operationalIssueWrites: 0,
            };
          }) as never,
        }
      );

    assert.equal(metrics.selected, 2);
    assert.equal(metrics.reconciled, 1);
    assert.equal(metrics.errors, 1);
    assert.equal(metrics.noAction, 1);
    assert.equal(
      metrics.errorCodeCounts
        .GUEST_JOURNEY_TEST_FAILURE,
      1
    );
  }
);

test(
  "rejects an enabled cycle without a canary scope",
  async () => {
    const prisma = {} as PrismaClient;

    await assert.rejects(
      runGuestJourneyEngineCycle(
        prisma,
        config({
          organizationIds: [],
          propertyIds: [],
        })
      ),
      /GUEST_JOURNEY_INTERNAL_RECONCILE_SCOPE_REQUIRED/
    );
  }
);
