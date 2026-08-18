import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import test from "node:test";

import {
  AccessMethod,
  AccessStatus,
  GuestAccessMode,
  GuestAccessReleaseStatus,
  GuestJourneyState,
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import type { AuditEntry } from "../apms/audit-types";
import {
  GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,
} from "./guest-journey-contract";
import type {
  GuestJourneyEvidenceSnapshot,
} from "./guest-journey-contract";
import {
  evaluateCanonicalGuestJourney,
} from "./guest-journey-evaluator";
import {
  reconcileGuestJourneyInTransaction,
} from "./guest-journey-reconciler.service";
import type {
  GuestJourneyReconcilerTransactionClient,
} from "./guest-journey-reconciler.service";

const CHECK_IN =
  new Date("2026-08-10T16:00:00.000Z");
const CHECK_OUT =
  new Date("2026-08-12T15:00:00.000Z");
const AGREEMENT_SIGNED_AT =
  new Date("2026-08-02T14:00:00.000Z");
const VERIFIED_AT =
  new Date("2026-08-02T14:05:00.000Z");
const ACCESS_RELEASED_AT =
  new Date("2026-08-10T14:00:00.000Z");
const ARRIVAL_NOW =
  new Date("2026-08-10T14:30:00.000Z");

type JourneyRow = {
  id: string;
  reservationId: string;
  currentState: GuestJourneyState;
  stateChangedAt: Date;
  verificationCompletedAt: Date | null;
  accessScheduledAt: Date | null;
  readyForArrivalAt: Date | null;
  stayActiveAt: Date | null;
  checkoutDueAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
};

type EvidenceOverrides = {
  evaluatedAt?: Date;
  reservation?: Partial<
    GuestJourneyEvidenceSnapshot["reservation"]
  >;
  requirements?: Partial<
    GuestJourneyEvidenceSnapshot["requirements"]
  >;
  verification?: Partial<
    GuestJourneyEvidenceSnapshot["verification"]
  >;
  access?: Partial<
    GuestJourneyEvidenceSnapshot["access"]
  >;
  persistedJourney?: Partial<
    GuestJourneyEvidenceSnapshot["persistedJourney"]
  >;
};

function createEvidence(
  overrides: EvidenceOverrides = {}
): GuestJourneyEvidenceSnapshot {
  return {
    contractVersion:
      GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,
    evaluatedAt:
      overrides.evaluatedAt ??
      new Date(
        "2026-08-01T12:00:00.000Z"
      ),
    reservation: {
      id: "reservation-1",
      reservationNumber:
        "PG-2026-000001",
      propertyId: "property-1",
      organizationId:
        "organization-1",
      status:
        ReservationStatus.ACTIVE,
      paymentState: PaymentState.PAID,
      source: "DIRECT_BOOKING",
      preferredLanguage: "en",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      cancelledAt: null,
      guestTokenPresent: true,
      guestTokenExpiresAt:
        new Date(
          "2026-08-13T15:00:00.000Z"
        ),
      ...overrides.reservation,
    },
    requirements: {
      agreementSnapshotPresent: true,
      agreementAcceptancePresent: false,
      agreementSignedAt: null,
      rulesAcceptedAt: null,
      cancellationSnapshotPresent: true,
      requiresIdentityVerification: true,
      identityVerificationRequiredSnapshot:
        true,
      agreementLanguage: "en",
      agreementVersion: "v1",
      ...overrides.requirements,
    },
    verification: {
      status: "PENDING",
      verifiedAt: null,
      attempts: 0,
      lastError: null,
      providerSessionPresent: false,
      ...overrides.verification,
    },
    access: {
      mode:
        GuestAccessMode.PASSCODE_ONLY,
      releaseStatus:
        GuestAccessReleaseStatus.BLOCKED,
      eligibleAt: null,
      releasedAt: null,
      canonicalGuestGrant: null,
      canonicalGuestGrantCandidateCount:
        0,
      guestGrantsOpen: 0,
      guestGrantsRevoked: 0,
      guestNfcScheduled: 0,
      guestNfcProvisioning: 0,
      guestNfcActive: 0,
      guestNfcFailed: 0,
      ...overrides.access,
    },
    communications: {
      signals: [],
    },
    persistedJourney: {
      exists: true,
      id: "journey-1",
      currentState:
        GuestJourneyState
          .RESERVATION_CONFIRMED,
      stateChangedAt:
        new Date(
          "2026-08-01T11:00:00.000Z"
        ),
      verificationCompletedAt: null,
      accessScheduledAt: null,
      readyForArrivalAt: null,
      stayActiveAt: null,
      checkoutDueAt: null,
      completedAt: null,
      cancelledAt: null,
      ...overrides.persistedJourney,
    },
    activeIntents: [],
  };
}

function completedAccessEvidence(
  persistedJourney:
    Partial<
      GuestJourneyEvidenceSnapshot["persistedJourney"]
    > = {}
): GuestJourneyEvidenceSnapshot {
  return createEvidence({
    evaluatedAt: ARRIVAL_NOW,
    requirements: {
      agreementAcceptancePresent: true,
      agreementSignedAt:
        AGREEMENT_SIGNED_AT,
      rulesAcceptedAt:
        AGREEMENT_SIGNED_AT,
    },
    verification: {
      status: "COMPLETED",
      verifiedAt: VERIFIED_AT,
      attempts: 1,
      providerSessionPresent: true,
    },
    access: {
      releaseStatus:
        GuestAccessReleaseStatus.RELEASED,
      eligibleAt:
        new Date(
          "2026-08-02T14:06:00.000Z"
        ),
      releasedAt: ACCESS_RELEASED_AT,
      canonicalGuestGrant: {
        id: "grant-1",
        status: AccessStatus.ACTIVE,
        method:
          AccessMethod.PASSCODE_TIMEBOUND,
        startsAt: CHECK_IN,
        endsAt: CHECK_OUT,
        ttlockKeyboardPwdIdPresent: true,
        secureAccessCodePresent: true,
      },
      canonicalGuestGrantCandidateCount:
        1,
      guestGrantsOpen: 1,
    },
    persistedJourney,
  });
}

function rowFromEvidence(
  evidence:
    GuestJourneyEvidenceSnapshot
): JourneyRow | null {
  const journey =
    evidence.persistedJourney;

  if (
    !journey.exists ||
    !journey.id ||
    !journey.currentState
  ) {
    return null;
  }

  return {
    id: journey.id,
    reservationId:
      evidence.reservation.id,
    currentState:
      journey.currentState,
    stateChangedAt:
      journey.stateChangedAt ??
      evidence.evaluatedAt,
    verificationCompletedAt:
      journey.verificationCompletedAt,
    accessScheduledAt:
      journey.accessScheduledAt,
    readyForArrivalAt:
      journey.readyForArrivalAt,
    stayActiveAt:
      journey.stayActiveAt,
    checkoutDueAt:
      journey.checkoutDueAt,
    completedAt:
      journey.completedAt,
    cancelledAt:
      journey.cancelledAt,
  };
}

function createFakeDatabase(input: {
  evidence:
    GuestJourneyEvidenceSnapshot;
  loseFirstCompareAndSetTo?:
    GuestJourneyState;
}) {
  let journey = rowFromEvidence(
    input.evidence
  );
  let loseFirstCompareAndSetTo =
    input.loseFirstCompareAndSetTo;
  const audits: AuditEntry[] = [];
  const updateCalls: unknown[] = [];
  const createCalls: unknown[] = [];
  const scopes: unknown[] = [];

  const guestJourney = {
    createMany: async (args: {
      data: Array<
        Partial<JourneyRow> & {
          reservationId: string;
          currentState:
            GuestJourneyState;
        }
      >;
    }) => {
      createCalls.push(args);

      if (journey) {
        return { count: 0 };
      }

      const data = args.data[0];
      journey = {
        id: "journey-created",
        reservationId:
          data.reservationId,
        currentState:
          data.currentState,
        stateChangedAt:
          data.stateChangedAt ??
          input.evidence.evaluatedAt,
        verificationCompletedAt:
          data.verificationCompletedAt ??
          null,
        accessScheduledAt:
          data.accessScheduledAt ?? null,
        readyForArrivalAt:
          data.readyForArrivalAt ?? null,
        stayActiveAt:
          data.stayActiveAt ?? null,
        checkoutDueAt:
          data.checkoutDueAt ?? null,
        completedAt:
          data.completedAt ?? null,
        cancelledAt:
          data.cancelledAt ?? null,
      };
      return { count: 1 };
    },
    findUnique: async (args: {
      where: {
        id?: string;
        reservationId?: string;
      };
    }) => {
      if (!journey) {
        return null;
      }

      if (
        args.where.id &&
        args.where.id !== journey.id
      ) {
        return null;
      }

      if (
        args.where.reservationId &&
        args.where.reservationId !==
          journey.reservationId
      ) {
        return null;
      }

      return { ...journey };
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      updateCalls.push(args);

      if (
        journey &&
        loseFirstCompareAndSetTo
      ) {
        journey.currentState =
          loseFirstCompareAndSetTo;
        loseFirstCompareAndSetTo =
          undefined;
        return { count: 0 };
      }

      if (
        !journey ||
        args.where.id !== journey.id ||
        (args.where.currentState &&
          args.where.currentState !==
            journey.currentState)
      ) {
        return { count: 0 };
      }

      for (const [key, value] of
        Object.entries(args.where)) {
        if (
          key !== "id" &&
          key !== "currentState" &&
          value === null &&
          journey[
            key as keyof JourneyRow
          ] !== null
        ) {
          return { count: 0 };
        }
      }

      Object.assign(journey, args.data);
      return { count: 1 };
    },
  };

  const tx = {
    guestJourney,
  } as unknown as
    GuestJourneyReconcilerTransactionClient;
  const dependencies = {
    loadEvidence: async (
      _tx: unknown,
      _reservationId: string,
      _now: Date,
      scope: unknown
    ) => {
      scopes.push(scope);
      return input.evidence;
    },
    evaluate:
      evaluateCanonicalGuestJourney,
    persistAudit: async (
      _tx: unknown,
      entry: AuditEntry
    ) => {
      const duplicate = audits.find(
        (candidate) =>
          candidate.decisionId ===
          entry.decisionId
      );

      if (!duplicate) {
        audits.push(entry);
      }

      return entry;
    },
  } as never;

  return {
    tx,
    dependencies,
    audits,
    updateCalls,
    createCalls,
    scopes,
    getJourney: () =>
      journey ? { ...journey } : null,
  };
}

const SCOPE = {
  organizationId: "organization-1",
  propertyId: "property-1",
};

test(
  "reconstructs a missing journey at the highest evidence-backed state without synthesizing history",
  async () => {
    const evidence =
      completedAccessEvidence({
        exists: false,
        id: null,
        currentState: null,
        stateChangedAt: null,
      });
    const database =
      createFakeDatabase({ evidence });

    const result =
      await reconcileGuestJourneyInTransaction(
        database.tx,
        evidence.reservation.id,
        ARRIVAL_NOW,
        SCOPE,
        database.dependencies
      );
    const journey =
      database.getJourney();

    assert.equal(
      result.finalPersistedState,
      GuestJourneyState.READY_FOR_ARRIVAL
    );
    assert.equal(
      result.actions[0].code,
      "CREATE_JOURNEY_FROM_EVIDENCE"
    );
    assert.equal(
      journey?.verificationCompletedAt,
      null
    );
    assert.equal(
      journey?.accessScheduledAt,
      null
    );
    assert.equal(
      journey?.readyForArrivalAt
        ?.toISOString(),
      ACCESS_RELEASED_AT.toISOString()
    );
    assert.equal(database.audits.length, 1);
    assert.equal(
      database.audits[0].engine,
      "GUEST_JOURNEY"
    );
    assert.equal(
      database.audits[0].metadata
        ?.coordinationIntentWritesEnabled,
      false
    );
  }
);

test(
  "advances only forward through compare-and-set transitions proven by evidence",
  async () => {
    const evidence =
      completedAccessEvidence({
        currentState:
          GuestJourneyState
            .VERIFICATION_COMPLETED,
        verificationCompletedAt:
          VERIFIED_AT,
      });
    const database =
      createFakeDatabase({ evidence });

    const result =
      await reconcileGuestJourneyInTransaction(
        database.tx,
        evidence.reservation.id,
        ARRIVAL_NOW,
        SCOPE,
        database.dependencies
      );

    assert.equal(
      result.finalPersistedState,
      GuestJourneyState.READY_FOR_ARRIVAL
    );
    assert.deepEqual(
      database.updateCalls.map(
        (call) =>
          (call as {
            data: {
              currentState?:
                GuestJourneyState;
            };
          }).data.currentState
      ),
      [
        GuestJourneyState.ACCESS_SCHEDULED,
        GuestJourneyState.READY_FOR_ARRIVAL,
      ]
    );
    assert.equal(database.audits.length, 2);
    assert.ok(
      database.audits.every(
        (entry) =>
          entry.engine ===
            "GUEST_JOURNEY" &&
          entry.decisions?.[0]
            ?.engine === "GUEST_JOURNEY"
      )
    );
    assert.equal(
      result.coordinationIntentWrites,
      0
    );
    assert.equal(
      result.operationalIssueWrites,
      0
    );
  }
);

test(
  "repairs only a missing timestamp for an aligned current state",
  async () => {
    const evidence =
      completedAccessEvidence({
        currentState:
          GuestJourneyState
            .READY_FOR_ARRIVAL,
        verificationCompletedAt:
          VERIFIED_AT,
        accessScheduledAt:
          ACCESS_RELEASED_AT,
        readyForArrivalAt: null,
      });
    const database =
      createFakeDatabase({ evidence });

    const result =
      await reconcileGuestJourneyInTransaction(
        database.tx,
        evidence.reservation.id,
        ARRIVAL_NOW,
        SCOPE,
        database.dependencies
      );

    assert.deepEqual(
      result.actions.map(
        (action) => action.code
      ),
      ["REPAIR_CANONICAL_TIMESTAMP"]
    );
    assert.equal(
      database.getJourney()
        ?.readyForArrivalAt
        ?.toISOString(),
      ACCESS_RELEASED_AT.toISOString()
    );
    assert.equal(database.audits.length, 1);
  }
);

test(
  "never regresses a journey that is ahead of evidence",
  async () => {
    const evidence = createEvidence({
      persistedJourney: {
        currentState:
          GuestJourneyState
            .READY_FOR_ARRIVAL,
        readyForArrivalAt:
          ACCESS_RELEASED_AT,
      },
    });
    const database =
      createFakeDatabase({ evidence });
    const result =
      await reconcileGuestJourneyInTransaction(
        database.tx,
        evidence.reservation.id,
        evidence.evaluatedAt,
        SCOPE,
        database.dependencies
      );

    assert.equal(
      result.actions[0].code,
      "PRESERVE_AHEAD_STATE"
    );
    assert.equal(
      database.updateCalls.length,
      0
    );
    assert.equal(database.audits.length, 0);
  }
);

test(
  "preserves an immutable terminal contradiction",
  async () => {
    const evidence = createEvidence({
      persistedJourney: {
        currentState:
          GuestJourneyState
            .JOURNEY_CANCELLED,
        cancelledAt:
          new Date(
            "2026-07-31T12:00:00.000Z"
          ),
      },
    });
    const database =
      createFakeDatabase({ evidence });
    const result =
      await reconcileGuestJourneyInTransaction(
        database.tx,
        evidence.reservation.id,
        evidence.evaluatedAt,
        SCOPE,
        database.dependencies
      );

    assert.equal(
      result.actions[0].code,
      "PRESERVE_TERMINAL_STATE"
    );
    assert.equal(
      database.updateCalls.length,
      0
    );
  }
);

test(
  "stops safely when a compare-and-set transition loses",
  async () => {
    const evidence =
      completedAccessEvidence({
        currentState:
          GuestJourneyState
            .VERIFICATION_COMPLETED,
        verificationCompletedAt:
          VERIFIED_AT,
      });
    const database = createFakeDatabase({
      evidence,
      loseFirstCompareAndSetTo:
        GuestJourneyState.ACCESS_SCHEDULED,
    });
    const result =
      await reconcileGuestJourneyInTransaction(
        database.tx,
        evidence.reservation.id,
        ARRIVAL_NOW,
        SCOPE,
        database.dependencies
      );

    assert.equal(
      result.finalPersistedState,
      GuestJourneyState.ACCESS_SCHEDULED
    );
    assert.deepEqual(
      result.actions.map(
        (action) => action.code
      ),
      ["COMPARE_AND_SET_LOST"]
    );
    assert.equal(database.audits.length, 0);
  }
);

test(
  "deduplicates two concurrent workers reconstructing the same missing journey",
  async () => {
    const evidence = createEvidence({
      persistedJourney: {
        exists: false,
        id: null,
        currentState: null,
        stateChangedAt: null,
      },
    });
    const database =
      createFakeDatabase({ evidence });
    const [first, second] =
      await Promise.all([
        reconcileGuestJourneyInTransaction(
          database.tx,
          evidence.reservation.id,
          evidence.evaluatedAt,
          SCOPE,
          database.dependencies
        ),
        reconcileGuestJourneyInTransaction(
          database.tx,
          evidence.reservation.id,
          evidence.evaluatedAt,
          SCOPE,
          database.dependencies
        ),
      ]);

    assert.equal(
      database.createCalls.length,
      2
    );
    assert.equal(database.audits.length, 1);
    assert.deepEqual(
      [
        first.actions[0].code,
        second.actions[0].code,
      ].sort(),
      [
        "COMPARE_AND_SET_LOST",
        "CREATE_JOURNEY_FROM_EVIDENCE",
      ].sort()
    );
  }
);

test(
  "passes the exact organization and property scope into the evidence loader",
  async () => {
    const evidence = createEvidence();
    const database =
      createFakeDatabase({ evidence });

    await reconcileGuestJourneyInTransaction(
      database.tx,
      evidence.reservation.id,
      evidence.evaluatedAt,
      SCOPE,
      database.dependencies
    );

    assert.deepEqual(
      database.scopes,
      [SCOPE]
    );

    await assert.rejects(
      reconcileGuestJourneyInTransaction(
        database.tx,
        evidence.reservation.id,
        evidence.evaluatedAt,
        {
          organizationId: "",
          propertyId: "property-1",
        },
        database.dependencies
      ),
      /GUEST_JOURNEY_RECONCILER_SCOPE_REQUIRED/
    );
  }
);

test(
  "is idempotent when the persisted journey is already aligned",
  async () => {
    const evidence =
      completedAccessEvidence({
        currentState:
          GuestJourneyState
            .READY_FOR_ARRIVAL,
        verificationCompletedAt:
          VERIFIED_AT,
        accessScheduledAt:
          ACCESS_RELEASED_AT,
        readyForArrivalAt:
          ACCESS_RELEASED_AT,
      });
    const database =
      createFakeDatabase({ evidence });
    const result =
      await reconcileGuestJourneyInTransaction(
        database.tx,
        evidence.reservation.id,
        ARRIVAL_NOW,
        SCOPE,
        database.dependencies
      );

    assert.deepEqual(
      result.actions.map(
        (action) => action.code
      ),
      ["NO_ACTION"]
    );
    assert.equal(
      database.updateCalls.length,
      0
    );
    assert.equal(database.audits.length, 0);
  }
);

test(
  "keeps E3 internal-only and uses parameterized advisory locking",
  () => {
    const source = readFileSync(
      new URL(
        "./guest-journey-reconciler.service.ts",
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
      /\.guestJourneyCoordinationIntent\b/
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
