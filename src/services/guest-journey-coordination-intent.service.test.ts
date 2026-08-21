import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
  GuestJourneyState,
} from "@prisma/client";

import type {
  AuditEntry,
} from "../apms/audit-types";
import type {
  CanonicalJourneyEvaluation,
  GuestJourneyCoordinationIntentSnapshot,
  GuestJourneyEvidenceSnapshot,
  ProposedJourneyCoordinationIntent,
} from "./guest-journey-contract";
import {
  GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,
} from "./guest-journey-contract";
import {
  materializeGuestJourneyCoordinationIntentsInTransaction,
} from "./guest-journey-coordination-intent.service";
import type {
  GuestJourneyCoordinationTransactionClient,
} from "./guest-journey-coordination-intent.service";
import {
  buildGuestJourneyCoordinationIntentKeyFromProposal,
} from "./guest-journey-coordination-intent-key";

const NOW = new Date(
  "2026-08-10T14:30:00.000Z"
);

const SCOPE = {
  organizationId: "organization-1",
  propertyId: "property-1",
};

const CURRENT_FINGERPRINT =
  "a".repeat(64);

const OLD_FINGERPRINT =
  "b".repeat(64);

function proposedIntent(
  overrides:
    Partial<
      ProposedJourneyCoordinationIntent
    > = {}
): ProposedJourneyCoordinationIntent {
  return {
    intentType:
      "REQUEST_ACCESS_EVALUATION",
    targetEngine: "ACCESS",
    reasonCode:
      "ACCESS_ELIGIBILITY_NOT_CONFIRMED",
    expectedOutcomeCode:
      "ACCESS_RELEASE_STATUS_ELIGIBLE",
    ...overrides,
  };
}

function activeIntent(
  overrides:
    Partial<
      GuestJourneyCoordinationIntentSnapshot
    > = {}
): GuestJourneyCoordinationIntentSnapshot {
  return {
    id: "intent-obsolete",
    intentKey: "intent-key-obsolete",
    intentType:
      "REQUEST_ACCESS_EVALUATION",
    targetEngine: "ACCESS",
    status:
      GuestJourneyCoordinationIntentStatus
        .PENDING,
    reasonCode:
      "ACCESS_ELIGIBILITY_NOT_CONFIRMED",
    expectedOutcomeCode:
      "ACCESS_RELEASE_STATUS_ELIGIBLE",
    evidenceFingerprint:
      OLD_FINGERPRINT,
    outcomeEvidenceFingerprint: null,
    claimCount: 0,
    leaseExpiresAt: null,
    nextActionAt: null,
    succeededAt: null,
    exhaustedAt: null,
    supersededAt: null,
    lastError: null,
    ...overrides,
  };
}

function evidence(input: {
  journeyExists?: boolean;
  activeIntents?:
    GuestJourneyCoordinationIntentSnapshot[];
} = {}): GuestJourneyEvidenceSnapshot {
  return {
    contractVersion:
      GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,
    evaluatedAt: NOW,
    reservation: {
      id: "reservation-1",
      reservationNumber:
        "PG-2026-000001",
      propertyId: "property-1",
      organizationId:
        "organization-1",
    },
    persistedJourney: {
      exists:
        input.journeyExists ?? true,
      id:
        input.journeyExists === false
          ? null
          : "journey-1",
      currentState:
        input.journeyExists === false
          ? null
          : GuestJourneyState
              .VERIFICATION_COMPLETED,
    },
    activeIntents:
      input.activeIntents ?? [],
  } as GuestJourneyEvidenceSnapshot;
}

function evaluation(
  intents:
    ProposedJourneyCoordinationIntent[]
): CanonicalJourneyEvaluation {
  return {
    contractVersion:
      "canonical_guest_journey_evaluator_v1",
    reservationId: "reservation-1",
    evaluatedAt: NOW,
    evidenceFingerprint:
      CURRENT_FINGERPRINT,
    temporalPhase: "PRE_ARRIVAL",
    expectedState:
      GuestJourneyState
        .VERIFICATION_COMPLETED,
    persistedState:
      GuestJourneyState
        .VERIFICATION_COMPLETED,
    comparison: "ALIGNED",
    stateReasonCode:
      "VERIFICATION_COMPLETED",
    stateReason:
      "Verification evidence is complete.",
    terminal: false,
    satisfiedRequirements: [],
    missingRequirements: [],
    blockers: [],
    inconsistencies: [],
    requiredInternalRepairs: [],
    requiredCoordinationIntents:
      intents,
    outcomeEvidence: {
      reservationActive: true,
      stayNotEnded: true,
      paymentSatisfied: true,
      legalRequirementsSatisfied: true,
      identityRequirementSatisfied: true,
      accessEligibilitySatisfied: false,
      accessProvisioningSatisfied: false,
      accessClosureSatisfied: false,
    },
  };
}

type Dependencies = NonNullable<
  Parameters<
    typeof materializeGuestJourneyCoordinationIntentsInTransaction
  >[4]
>;

function createFakeDatabase(input: {
  evidence:
    GuestJourneyEvidenceSnapshot;
  evaluation:
    CanonicalJourneyEvaluation;
  updateCount?: number;
  reactivationCount?: number;
  existingKeys?: string[];
}) {
  const createdKeys = new Set<string>(
    input.existingKeys ?? []
  );
  const createCalls: unknown[] = [];
  const updateCalls: unknown[] = [];
  const audits: AuditEntry[] = [];
  const scopes: unknown[] = [];
  const tx = {
    reservation: {},
    guestJourneyCoordinationIntent: {
      createMany: async (
        args: {
          data: Array<{
            intentKey: string;
          }>;
        }
      ) => {
        createCalls.push(args);
        const intentKey =
          args.data[0]?.intentKey;

        if (
          !intentKey ||
          createdKeys.has(intentKey)
        ) {
          return { count: 0 };
        }

        createdKeys.add(intentKey);
        return { count: 1 };
      },
      updateMany: async (args: {
        where?: {
          intentKey?: unknown;
        };
      }) => {
        updateCalls.push(args);
        return {
          count: args.where?.intentKey
            ? input.reactivationCount ?? 0
            : input.updateCount ?? 1,
        };
      },
    },
    apmsAuditEntry: {},
  } as unknown as
    GuestJourneyCoordinationTransactionClient;
  const dependencies: Dependencies = {
    loadEvidence: (async (
      _prisma: unknown,
      _reservationId: string,
      _now: Date,
      scope: unknown
    ) => {
      scopes.push(scope);
      return input.evidence;
    }) as Dependencies["loadEvidence"],
    evaluate: (() =>
      input.evaluation) as
      Dependencies["evaluate"],
    persistAudit: (async (
      _prisma: unknown,
      entry: AuditEntry
    ) => {
      audits.push(entry);
      return {};
    }) as Dependencies["persistAudit"],
  };

  return {
    tx,
    dependencies,
    createCalls,
    updateCalls,
    audits,
    scopes,
  };
}

test(
  "materializes distinct normalized intents idempotently without owner execution",
  async () => {
    const database = createFakeDatabase({
      evidence: evidence(),
      evaluation: evaluation([
        proposedIntent(),
        proposedIntent({
          intentType:
            "REQUEST_COMMUNICATION_RETRY",
          targetEngine:
            "COMMUNICATIONS",
          reasonCode:
            "COMMUNICATION_DELIVERY_FAILED",
          expectedOutcomeCode:
            "COMMUNICATION_DELIVERY_FINAL",
          payload: {
            communicationType:
              "precheckin_invitation",
            channel: "email",
          },
        }),
        proposedIntent({
          intentType:
            "REQUEST_COMMUNICATION_RETRY",
          targetEngine:
            "COMMUNICATIONS",
          reasonCode:
            "COMMUNICATION_DELIVERY_FAILED",
          expectedOutcomeCode:
            "COMMUNICATION_DELIVERY_FINAL",
          payload: {
            communicationType:
              "PRECHECKIN_INVITATION",
            channel: "sms",
          },
        }),
      ]),
    });
    const first =
      await materializeGuestJourneyCoordinationIntentsInTransaction(
        database.tx,
        "reservation-1",
        NOW,
        SCOPE,
        database.dependencies
      );
    const second =
      await materializeGuestJourneyCoordinationIntentsInTransaction(
        database.tx,
        "reservation-1",
        NOW,
        SCOPE,
        database.dependencies
      );

    assert.equal(first.created, 3);
    assert.equal(
      first.coordinationIntentWrites,
      3
    );
    assert.equal(
      first.ownerEngineExecutions,
      0
    );
    assert.equal(
      first.operationalIssueWrites,
      0
    );
    assert.equal(second.created, 0);
    assert.equal(second.deduplicated, 3);
    assert.equal(database.audits.length, 1);
    assert.deepEqual(database.scopes, [
      SCOPE,
      SCOPE,
    ]);

    const payloads = database.createCalls
      .map(
        (call) =>
          (
            call as {
              data: Array<{
                payload?: unknown;
              }>;
            }
          ).data[0]?.payload
      )
      .filter(Boolean);

    assert.deepEqual(payloads, [
      {
        communicationType:
          "PRECHECKIN_INVITATION",
        channel: "EMAIL",
      },
      {
        communicationType:
          "PRECHECKIN_INVITATION",
        channel: "SMS",
      },
      {
        communicationType:
          "PRECHECKIN_INVITATION",
        channel: "EMAIL",
      },
      {
        communicationType:
          "PRECHECKIN_INVITATION",
        channel: "SMS",
      },
    ]);
  }
);

test(
  "supersedes obsolete unclaimed evidence and materializes the replacement",
  async () => {
    const database = createFakeDatabase({
      evidence: evidence({
        activeIntents: [
          activeIntent(),
        ],
      }),
      evaluation: evaluation([
        proposedIntent(),
      ]),
    });
    const result =
      await materializeGuestJourneyCoordinationIntentsInTransaction(
        database.tx,
        "reservation-1",
        NOW,
        SCOPE,
        database.dependencies
      );

    assert.equal(result.superseded, 1);
    assert.equal(result.created, 1);
    assert.equal(
      result.coordinationIntentWrites,
      2
    );
    assert.equal(
      database.updateCalls.length,
      1
    );
    assert.equal(database.audits.length, 1);
  }
);

test(
  "reactivates an exact superseded intent when its evidence becomes current again",
  async () => {
    const required = proposedIntent();
    const intentKey =
      buildGuestJourneyCoordinationIntentKeyFromProposal(
        "reservation-1",
        CURRENT_FINGERPRINT,
        required
      );
    const database = createFakeDatabase({
      evidence: evidence(),
      evaluation: evaluation([required]),
      existingKeys: [intentKey],
      reactivationCount: 1,
    });
    const result =
      await materializeGuestJourneyCoordinationIntentsInTransaction(
        database.tx,
        "reservation-1",
        NOW,
        SCOPE,
        database.dependencies
      );

    assert.equal(result.created, 0);
    assert.equal(result.reactivated, 1);
    assert.equal(result.deduplicated, 0);
    assert.equal(
      result.coordinationIntentWrites,
      1
    );
    assert.deepEqual(
      result.actions.map(
        (action) => action.code
      ),
      ["REACTIVATE_SUPERSEDED_INTENT"]
    );
    assert.equal(
      database.updateCalls.length,
      1
    );
    const reactivationCall =
      database.updateCalls[0] as {
        where: {
          intentKey: string;
          status:
            GuestJourneyCoordinationIntentStatus;
        };
        data: {
          status:
            GuestJourneyCoordinationIntentStatus;
          claimCount: number;
          supersededAt: Date | null;
        };
      };
    assert.equal(
      reactivationCall.where.intentKey,
      intentKey
    );
    assert.equal(
      reactivationCall.where.status,
      GuestJourneyCoordinationIntentStatus
        .SUPERSEDED
    );
    assert.equal(
      reactivationCall.data.status,
      GuestJourneyCoordinationIntentStatus
        .PENDING
    );
    assert.equal(
      reactivationCall.data.claimCount,
      0
    );
    assert.equal(
      reactivationCall.data.supersededAt,
      null
    );
    assert.equal(database.audits.length, 1);
    assert.deepEqual(
      database.audits[0]?.metadata
        ?.reactivatedKeys,
      [intentKey]
    );
  }
);

test(
  "preserves a live stale claim and blocks its replacement pair",
  async () => {
    const database = createFakeDatabase({
      evidence: evidence({
        activeIntents: [
          activeIntent({
            status:
              GuestJourneyCoordinationIntentStatus
                .CLAIMED,
            leaseExpiresAt:
              new Date(
                NOW.getTime() + 60_000
              ),
          }),
        ],
      }),
      evaluation: evaluation([
        proposedIntent(),
      ]),
    });
    const result =
      await materializeGuestJourneyCoordinationIntentsInTransaction(
        database.tx,
        "reservation-1",
        NOW,
        SCOPE,
        database.dependencies
      );

    assert.equal(
      result.activeClaimsPreserved,
      1
    );
    assert.equal(result.created, 0);
    assert.equal(result.superseded, 0);
    assert.equal(
      result.coordinationIntentWrites,
      0
    );
    assert.equal(
      database.createCalls.length,
      0
    );
    assert.equal(
      database.updateCalls.length,
      0
    );
    assert.equal(database.audits.length, 0);
  }
);

test(
  "deduplicates an exact active intent without rewriting it",
  async () => {
    const required = proposedIntent();
    const intentKey =
      buildGuestJourneyCoordinationIntentKeyFromProposal(
        "reservation-1",
        CURRENT_FINGERPRINT,
        required
      );
    const database = createFakeDatabase({
      evidence: evidence({
        activeIntents: [
          activeIntent({
            intentKey,
            evidenceFingerprint:
              CURRENT_FINGERPRINT,
          }),
        ],
      }),
      evaluation: evaluation([required]),
    });
    const result =
      await materializeGuestJourneyCoordinationIntentsInTransaction(
        database.tx,
        "reservation-1",
        NOW,
        SCOPE,
        database.dependencies
      );

    assert.equal(result.created, 0);
    assert.equal(result.deduplicated, 1);
    assert.equal(result.superseded, 0);
    assert.equal(
      result.coordinationIntentWrites,
      0
    );
    assert.equal(
      database.createCalls.length,
      0
    );
    assert.equal(
      database.updateCalls.length,
      0
    );
  }
);

test(
  "blocks a replacement when supersession loses a concurrent compare-and-set",
  async () => {
    const database = createFakeDatabase({
      evidence: evidence({
        activeIntents: [
          activeIntent(),
        ],
      }),
      evaluation: evaluation([
        proposedIntent(),
      ]),
      updateCount: 0,
    });
    const result =
      await materializeGuestJourneyCoordinationIntentsInTransaction(
        database.tx,
        "reservation-1",
        NOW,
        SCOPE,
        database.dependencies
      );

    assert.equal(
      result.compareAndSetLost,
      1
    );
    assert.equal(result.created, 0);
    assert.equal(
      result.coordinationIntentWrites,
      0
    );
    assert.equal(
      database.createCalls.length,
      0
    );
  }
);

test(
  "refuses to create intents when the canonical journey is missing",
  async () => {
    const database = createFakeDatabase({
      evidence: evidence({
        journeyExists: false,
      }),
      evaluation: evaluation([
        proposedIntent(),
      ]),
    });
    const result =
      await materializeGuestJourneyCoordinationIntentsInTransaction(
        database.tx,
        "reservation-1",
        NOW,
        SCOPE,
        database.dependencies
      );

    assert.deepEqual(
      result.actions.map(
        (action) => action.code
      ),
      ["JOURNEY_MISSING"]
    );
    assert.equal(
      result.coordinationIntentWrites,
      0
    );
    assert.equal(
      database.createCalls.length,
      0
    );
  }
);

test(
  "keeps E4 at the durable intent boundary with parameterized locking",
  () => {
    const source = readFileSync(
      new URL(
        "./guest-journey-coordination-intent.service.ts",
        import.meta.url
      ),
      "utf8"
    );

    assert.match(
      source,
      /pg_advisory_xact_lock/
    );
    assert.match(source, /Prisma\.sql/);
    assert.doesNotMatch(
      source,
      /\$executeRawUnsafe/
    );
    assert.doesNotMatch(
      source,
      /\.operationalIssue\b/
    );
    assert.doesNotMatch(
      source,
      /(?:sendLoggedEmail|sendGuest|activateGrant|deactivateGrant|ttlock|stripe)/i
    );
  }
);
