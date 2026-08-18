import assert from "node:assert/strict";
import test from "node:test";

import {
  AccessGrantType,
  AccessMethod,
  AccessStatus,
  GuestAccessMode,
  GuestAccessReleaseStatus,
  GuestJourneyState,
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import {
  runGuestJourneyShadowCycle,
} from "./guest-journey-shadow-cycle.service";
import type {
  GuestJourneyShadowConfig,
} from "./guest-journey-shadow.config";

const NOW = new Date(
  "2026-08-10T12:00:00.000Z"
);
const CHECK_IN = new Date(
  "2026-08-10T16:00:00.000Z"
);
const CHECK_OUT = new Date(
  "2026-08-12T15:00:00.000Z"
);

function enabledConfig(
  overrides: Partial<
    GuestJourneyShadowConfig
  > = {}
): GuestJourneyShadowConfig {
  return {
    enabled: true,
    batchSize: 1,
    horizonDays: 90,
    lookbackDays: 7,
    organizationIds: ["organization-1"],
    propertyIds: [],
    ...overrides,
  };
}

function createReservationEvidence(
  organizationId = "organization-1"
) {
  return {
    id: "reservation-1",
    reservationNumber: "PG-2026-000001",
    propertyId: "property-1",
    status: ReservationStatus.ACTIVE,
    paymentState: PaymentState.PAID,
    source: "DIRECT_BOOKING",
    preferredLanguage: "es",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    cancelledAt: null,
    guestToken: "secret-token",
    guestTokenExpiresAt: new Date(
      "2026-08-13T15:00:00.000Z"
    ),
    guestAgreementSnapshot: {
      agreementId: "agreement-1",
      propertyId: "property-1",
      version: "v1",
      language: "es",
      requiresIdentityVerification: true,
      capturedAt:
        "2026-08-01T12:00:00.000Z",
    },
    guestAgreementAcceptance: {
      accepted: true,
    },
    guestAgreementSignedAt: new Date(
      "2026-08-02T14:00:00.000Z"
    ),
    verificationAcceptedRulesAt: new Date(
      "2026-08-02T14:00:00.000Z"
    ),
    cancellationPolicySnapshot: {
      type: "FLEXIBLE",
    },
    identityVerificationRequiredSnapshot:
      true,
    verificationStatus: "COMPLETED",
    verifiedAt: new Date(
      "2026-08-02T14:05:00.000Z"
    ),
    identityVerificationAttempts: 1,
    stripeIdentityVerificationLastError:
      null,
    stripeIdentityVerificationSessionId:
      "provider-session-secret",
    guestAccessModeSnapshot:
      GuestAccessMode.PASSCODE_ONLY,
    guestAccessReleaseStatus:
      GuestAccessReleaseStatus.RELEASED,
    guestAccessEligibleAt: new Date(
      "2026-08-02T14:06:00.000Z"
    ),
    guestAccessReleasedAt: new Date(
      "2026-08-10T11:00:00.000Z"
    ),
    property: {
      organizationId,
    },
    guestJourney: {
      id: "journey-1",
      currentState:
        GuestJourneyState
          .VERIFICATION_COMPLETED,
      stateChangedAt: new Date(
        "2026-08-02T14:05:00.000Z"
      ),
      verificationCompletedAt: new Date(
        "2026-08-02T14:05:00.000Z"
      ),
      accessScheduledAt: null,
      readyForArrivalAt: null,
      stayActiveAt: null,
      checkoutDueAt: null,
      completedAt: null,
      cancelledAt: null,
    },
    accessGrants: [
      {
        id: "grant-1",
        type: AccessGrantType.GUEST,
        method:
          AccessMethod.PASSCODE_TIMEBOUND,
        status: AccessStatus.ACTIVE,
        startsAt: CHECK_IN,
        endsAt: CHECK_OUT,
        ttlockKeyboardPwdId: 123456,
        secureAccessCode: {
          id: "access-code-1",
          accessCodeEnc:
            "encrypted-passcode-secret",
        },
      },
    ],
    NfcAssignment: [],
    messageDispatchLogs: [
      {
        id: "dispatch-1",
        type: "BOOKING_CONFIRMATION",
        channel: "email",
        status: "SENT",
        createdAt: new Date(
          "2026-08-01T12:00:00.000Z"
        ),
      },
    ],
    guestJourneyCoordinationIntents: [],
    _count: {
      accessGrants: 0,
    },
  };
}

function createMockClient(input?: {
  organizationId?: string;
  auditCreateError?: unknown;
  candidates?: Array<{
    id: string;
    propertyId: string;
    property: {
      organizationId: string;
    };
  }>;
}) {
  const auditByDecisionId =
    new Map<string, any>();
  const calls = {
    candidateFindMany: [] as any[],
    evidenceFindUnique: [] as any[],
    auditFindUnique: [] as any[],
    auditCreate: [] as any[],
  };
  const candidates =
    input?.candidates ?? [
      {
        id: "reservation-1",
        propertyId: "property-1",
        property: {
          organizationId:
            "organization-1",
        },
      },
    ];
  const reservation =
    createReservationEvidence(
      input?.organizationId
    );

  const prisma = {
    reservation: {
      findMany: async (args: any) => {
        calls.candidateFindMany.push(args);
        return candidates;
      },
      findUnique: async (args: any) => {
        calls.evidenceFindUnique.push(args);
        return reservation;
      },
    },
    apmsAuditEntry: {
      findUnique: async (args: any) => {
        calls.auditFindUnique.push(args);
        return (
          auditByDecisionId.get(
            args.where.decisionId
          ) ?? null
        );
      },
      create: async (args: any) => {
        calls.auditCreate.push(args);
        if (input?.auditCreateError) {
          throw input.auditCreateError;
        }
        const created = {
          id: `audit-${
            calls.auditCreate.length
          }`,
          createdAt: NOW,
          ...args.data,
        };
        auditByDecisionId.set(
          args.data.decisionId,
          created
        );
        return created;
      },
    },
  };

  return {
    prisma: prisma as any,
    calls,
  };
}

test(
  "performs no query or write while shadow mode is disabled",
  async () => {
    const { prisma, calls } =
      createMockClient();

    const metrics =
      await runGuestJourneyShadowCycle(
        prisma,
        enabledConfig({
          enabled: false,
          organizationIds: [],
        }),
        { now: NOW }
      );

    assert.equal(metrics.enabled, false);
    assert.equal(metrics.selected, 0);
    assert.equal(
      calls.candidateFindMany.length,
      0
    );
    assert.equal(calls.auditCreate.length, 0);
  }
);

test(
  "evaluates one tenant-scoped bounded candidate and writes only canonical shadow audit",
  async () => {
    const { prisma, calls } =
      createMockClient();
    const logs: any[] = [];

    const metrics =
      await runGuestJourneyShadowCycle(
        prisma,
        enabledConfig(),
        {
          now: NOW,
          logger: (entry) =>
            logs.push(entry),
        }
      );

    assert.equal(metrics.selected, 1);
    assert.equal(metrics.evaluated, 1);
    assert.equal(metrics.errors, 0);
    assert.equal(metrics.auditCreated, 1);
    assert.equal(
      metrics.comparisonCounts.BEHIND,
      1
    );
    assert.equal(
      metrics.expectedStateCounts[
        GuestJourneyState.ACCESS_SCHEDULED
      ],
      1
    );
    assert.equal(metrics.nextCursor, "reservation-1");

    const candidateQuery =
      calls.candidateFindMany[0];
    assert.equal(candidateQuery.take, 1);
    assert.deepEqual(
      candidateQuery.orderBy,
      { id: "asc" }
    );

    assert.equal(calls.auditCreate.length, 1);
    const audit =
      calls.auditCreate[0].data;
    assert.equal(audit.engine, "GUEST_JOURNEY");
    assert.equal(
      audit.metadata.shadow,
      true
    );
    assert.equal(
      audit.metadata.runtimeWritesEnabled,
      false
    );
    assert.equal(
      audit.decisions[0].applied,
      false
    );

    const serialized = JSON.stringify({
      audit,
      logs,
    });
    assert.equal(
      serialized.includes("secret-token"),
      false
    );
    assert.equal(
      serialized.includes(
        "encrypted-passcode-secret"
      ),
      false
    );
    assert.equal(
      serialized.includes(
        "provider-session-secret"
      ),
      false
    );
  }
);

test(
  "deduplicates the same immutable shadow result across repeated cycles",
  async () => {
    const { prisma, calls } =
      createMockClient();

    const first =
      await runGuestJourneyShadowCycle(
        prisma,
        enabledConfig(),
        { now: NOW }
      );
    const second =
      await runGuestJourneyShadowCycle(
        prisma,
        enabledConfig(),
        { now: NOW }
      );

    assert.equal(first.auditCreated, 1);
    assert.equal(
      second.auditDeduplicated,
      1
    );
    assert.equal(calls.auditCreate.length, 1);
  }
);

test(
  "treats a concurrent audit unique conflict as deduplicated",
  async () => {
    const concurrentConflict =
      Object.assign(
        new Error(
          "Unique constraint failed"
        ),
        {
          code: "P2002",
          meta: {
            target: ["decisionId"],
          },
        }
      );
    const { prisma, calls } =
      createMockClient({
        auditCreateError:
          concurrentConflict,
      });

    const metrics =
      await runGuestJourneyShadowCycle(
        prisma,
        enabledConfig(),
        { now: NOW }
      );

    assert.equal(metrics.errors, 0);
    assert.equal(
      metrics.auditCreated,
      0
    );
    assert.equal(
      metrics.auditDeduplicated,
      1
    );
    assert.equal(
      calls.auditCreate.length,
      1
    );
  }
);

test(
  "does not hide an unrelated audit unique conflict",
  async () => {
    const unrelatedConflict =
      Object.assign(
        new Error(
          "Unique constraint failed"
        ),
        {
          code: "P2002",
          meta: {
            target: ["id"],
          },
        }
      );
    const { prisma } =
      createMockClient({
        auditCreateError:
          unrelatedConflict,
      });

    const metrics =
      await runGuestJourneyShadowCycle(
        prisma,
        enabledConfig(),
        { now: NOW }
      );

    assert.equal(metrics.errors, 1);
    assert.equal(
      metrics.auditDeduplicated,
      0
    );
    assert.equal(
      metrics.errorCodeCounts.P2002,
      1
    );
  }
);

test(
  "contains a tenant mismatch as a shadow error without creating an audit or host issue",
  async () => {
    const { prisma, calls } =
      createMockClient({
        organizationId:
          "organization-other",
      });

    const metrics =
      await runGuestJourneyShadowCycle(
        prisma,
        enabledConfig(),
        { now: NOW }
      );

    assert.equal(metrics.evaluated, 0);
    assert.equal(metrics.errors, 1);
    assert.equal(
      metrics.errorCodeCounts[
        "GUEST_JOURNEY_EVIDENCE_SCOPE_MISMATCH"
      ],
      1
    );
    assert.equal(calls.auditCreate.length, 0);
    assert.equal(
      "operationalIssue" in prisma,
      false
    );
  }
);

test(
  "uses a cursor and wraps only after the final partial batch",
  async () => {
    const { prisma, calls } =
      createMockClient({
        candidates: [],
      });

    const metrics =
      await runGuestJourneyShadowCycle(
        prisma,
        enabledConfig(),
        {
          now: NOW,
          cursor: "reservation-last",
        }
      );

    assert.equal(metrics.nextCursor, null);
    assert.deepEqual(
      calls.candidateFindMany[0].cursor,
      { id: "reservation-last" }
    );
    assert.equal(
      calls.candidateFindMany[0].skip,
      1
    );
  }
);
