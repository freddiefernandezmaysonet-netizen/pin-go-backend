import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyState,
} from "@prisma/client";
import type {
  PrismaClient,
} from "@prisma/client";

import {
  runGuestJourneyCoordinationCycle,
} from "./guest-journey-coordination-cycle.service";
import type {
  GuestJourneyCoordinationConfig,
} from "./guest-journey-coordination.config";

function config(
  overrides:
    Partial<
      GuestJourneyCoordinationConfig
    > = {}
): GuestJourneyCoordinationConfig {
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

function materializationResult(
  reservationId: string
) {
  return {
    reservationId,
    journeyId:
      `journey-${reservationId}`,
    evaluation: {
      contractVersion:
        "canonical_guest_journey_evaluator_v1" as const,
      reservationId,
      evaluatedAt: new Date(),
      evidenceFingerprint:
        "fingerprint",
      temporalPhase:
        "PRE_ARRIVAL" as const,
      expectedState:
        GuestJourneyState
          .VERIFICATION_PENDING,
      persistedState:
        GuestJourneyState
          .VERIFICATION_PENDING,
      comparison: "ALIGNED" as const,
      stateReasonCode: "test",
      stateReason: "test",
      terminal: false,
      satisfiedRequirements: [],
      missingRequirements: [],
      blockers: [],
      inconsistencies: [],
      requiredInternalRepairs: [],
      requiredCoordinationIntents: [],
      outcomeEvidence: {
        reservationActive: true,
        stayNotEnded: true,
        paymentSatisfied: true,
        legalRequirementsSatisfied: true,
        identityRequirementSatisfied:
          false,
        accessEligibilitySatisfied:
          false,
        accessProvisioningSatisfied:
          false,
        accessClosureSatisfied: false,
      },
    },
    proposed: 2,
    created: 1,
    deduplicated: 1,
    superseded: 1,
    activeClaimsPreserved: 0,
    compareAndSetLost: 0,
    coordinationIntentWrites: 2,
    operationalIssueWrites: 0 as const,
    ownerEngineExecutions: 0 as const,
    actions: [
      {
        code:
          "CREATE_COORDINATION_INTENT" as const,
        detail: "created",
      },
      {
        code:
          "SUPERSEDE_OBSOLETE_INTENT" as const,
        detail: "superseded",
      },
    ],
  };
}

test(
  "performs no database read when E4 is disabled",
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
      await runGuestJourneyCoordinationCycle(
        prisma,
        config({
          enabled: false,
          organizationIds: [],
          propertyIds: [],
        })
      );

    assert.equal(reads, 0);
    assert.equal(metrics.enabled, false);
    assert.equal(
      metrics.ownerEngineExecutions,
      0
    );
    assert.equal(
      metrics.operationalIssueWrites,
      0
    );
  }
);

test(
  "selects a bounded tenant-scoped batch and aggregates only intent writes",
  async () => {
    const queryCalls: unknown[] = [];
    const materializeCalls: Array<{
      id: string;
      scope: unknown;
    }> = [];
    const prisma = {
      reservation: {
        findMany: async (args: unknown) => {
          queryCalls.push(args);
          return [
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
        },
      },
    } as unknown as PrismaClient;
    const metrics =
      await runGuestJourneyCoordinationCycle(
        prisma,
        config(),
        {
          now: new Date(
            "2026-08-10T14:30:00.000Z"
          ),
          cursor: "reservation-0",
          materialize: (async (
            _prisma: PrismaClient,
            id: string,
            options: {
              scope: unknown;
            }
          ) => {
            materializeCalls.push({
              id,
              scope: options.scope,
            });
            return materializationResult(id);
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
    assert.deepEqual(materializeCalls, [
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
    assert.equal(metrics.evaluated, 2);
    assert.equal(metrics.intentsProposed, 4);
    assert.equal(metrics.intentsCreated, 2);
    assert.equal(
      metrics.intentsDeduplicated,
      2
    );
    assert.equal(
      metrics.intentsSuperseded,
      2
    );
    assert.equal(
      metrics.coordinationIntentWrites,
      4
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
  "isolates one reservation failure and continues the bounded cycle",
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
      await runGuestJourneyCoordinationCycle(
        prisma,
        config(),
        {
          materialize: (async (
            _prisma: PrismaClient,
            id: string
          ) => {
            if (id === "reservation-fail") {
              throw new Error(
                "GUEST_JOURNEY_COORDINATION_TEST_FAILURE:boom"
              );
            }

            return materializationResult(id);
          }) as never,
        }
      );

    assert.equal(metrics.selected, 2);
    assert.equal(metrics.evaluated, 1);
    assert.equal(metrics.errors, 1);
    assert.equal(
      metrics.errorCodeCounts
        .GUEST_JOURNEY_COORDINATION_TEST_FAILURE,
      1
    );
  }
);

test(
  "rejects an enabled cycle without a canary scope",
  async () => {
    await assert.rejects(
      runGuestJourneyCoordinationCycle(
        {} as PrismaClient,
        config({
          organizationIds: [],
          propertyIds: [],
        })
      ),
      /COORDINATION_INTENTS_SCOPE_REQUIRED/
    );
  }
);
