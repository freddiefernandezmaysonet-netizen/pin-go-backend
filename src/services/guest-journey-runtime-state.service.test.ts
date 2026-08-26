import assert from "node:assert/strict";
import test from "node:test";

import {
  ApmsRuntimePreflightStatus,
  ApmsRuntimeStatus,
  type PrismaClient,
} from "@prisma/client";

import {
  buildGuestJourneyRuntimeIdentity,
  buildResolvedGuestJourneyRuntimeSnapshot,
  evaluateGuestJourneyRuntimeTick,
  hashGuestJourneyRuntimeScopeId,
  initializeGuestJourneyRuntimeState,
  isGuestJourneyRuntimeFailureRecoveryEligible,
  isGuestJourneyRuntimeScopeMatch,
  recordGuestJourneyRuntimeHeartbeat,
} from "./guest-journey-runtime-state.service";
import {
  resolveGuestJourneyActivationControlPlaneConfig,
} from "./guest-journey-activation-control-plane.service";

type RuntimeRow = Record<string, any> & {
  id: string;
};

function runtimePrismaMock() {
  const rows = new Map<string, RuntimeRow>();
  let sequence = 0;

  const prisma = {
    apmsRuntimeState: {
      async create({ data }: any) {
        sequence += 1;
        const row = {
          id: `runtime-${sequence}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          operationalIssueId: null,
          ...data,
        };
        rows.set(row.id, row);
        return row;
      },
      async update({ where, data }: any) {
        const current = rows.get(where.id);
        if (!current) {
          throw new Error("ROW_NOT_FOUND");
        }
        const next = {
          ...current,
          ...data,
          updatedAt: new Date(),
        };
        rows.set(where.id, next);
        return next;
      },
      async updateMany({ where, data }: any) {
        const current = rows.get(where.id);
        if (!current) return { count: 0 };
        rows.set(where.id, {
          ...current,
          ...data,
          updatedAt: new Date(),
        });
        return { count: 1 };
      },
    },
    operationalIssue: {
      async findUnique() {
        return null;
      },
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    latest() {
      return Array.from(rows.values()).at(-1);
    },
  };
}

const noIssue = async () => null as any;

function shadowOnlyEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    RAILWAY_SERVICE_NAME:
      "reservation-worker",
    GUEST_JOURNEY_APMS_ACTIVATION_PROFILE:
      "shadow_only",
    GUEST_JOURNEY_SHADOW_ENABLED: "1",
    GUEST_JOURNEY_SHADOW_ORGANIZATION_IDS:
      "org-secret-1",
    GUEST_JOURNEY_SHADOW_PROPERTY_IDS:
      "property-secret-1",
  };
}

test("E13 runtime identity contains deployment/boot context but no tenant scope", () => {
  const identity =
    buildGuestJourneyRuntimeIdentity(
      {
        NODE_ENV: "test",
        RAILWAY_SERVICE_NAME:
          "reservation-worker",
        RAILWAY_REPLICA_ID:
          "replica-1",
        RAILWAY_GIT_COMMIT_SHA:
          "abc123",
        RAILWAY_DEPLOYMENT_ID:
          "deployment-1",
      },
      "boot-1"
    );

  assert.equal(
    identity.runtimeName,
    "GUEST_JOURNEY"
  );
  assert.equal(identity.bootId, "boot-1");
  assert.equal(identity.instanceId, "replica-1");
  assert.equal(identity.deploymentSha, "abc123");
  assert.doesNotMatch(
    JSON.stringify(identity),
    /organizationId|propertyId/
  );
});

test("E13 persists only SHA-256 scope/config fingerprints and hashed membership", () => {
  const config =
    resolveGuestJourneyActivationControlPlaneConfig(
      shadowOnlyEnvironment()
    );
  const snapshot =
    buildResolvedGuestJourneyRuntimeSnapshot(
      config
    );
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.configFingerprint.length, 64);
  assert.equal(snapshot.scopeFingerprint.length, 64);
  assert.equal(snapshot.organizationScopeCount, 1);
  assert.equal(snapshot.propertyScopeCount, 1);
  assert.doesNotMatch(
    serialized,
    /org-secret-1|property-secret-1/
  );
  assert.deepEqual(
    snapshot.organizationScopeHashes,
    [
      hashGuestJourneyRuntimeScopeId(
        "organization",
        "org-secret-1"
      ),
    ]
  );
});

test("E13 records invalid E11 configuration durably and returns safe off fallback", async () => {
  const mock = runtimePrismaMock();
  const context =
    await initializeGuestJourneyRuntimeState(
      mock.prisma,
      {
        GUEST_JOURNEY_APMS_ACTIVATION_PROFILE:
          "invalid-profile",
      },
      {
        now: new Date(
          "2026-08-25T12:00:00.000Z"
        ),
        bootId: "boot-invalid",
        dependencies: {
          resolveConfig() {
            throw new Error(
              "GUEST_JOURNEY_APMS_ACTIVATION_PROFILE_INVALID: raw-secret-value"
            );
          },
          persistFailureIssue: noIssue,
        },
      }
    );
  const row = mock.latest();

  assert.equal(context.configurationValid, false);
  assert.equal(context.config.profile, "off");
  assert.equal(row?.status, ApmsRuntimeStatus.ERROR);
  assert.equal(
    row?.preflightStatus,
    ApmsRuntimePreflightStatus.FAILED
  );
  assert.doesNotMatch(
    String(row?.lastPreflightErrorMessage),
    /raw-secret-value/
  );
});

test("E13 off profile remains fresh but Mission Control can classify it PAUSED", async () => {
  const mock = runtimePrismaMock();
  const context =
    await initializeGuestJourneyRuntimeState(
      mock.prisma,
      {},
      {
        bootId: "boot-off",
        dependencies: {
          persistFailureIssue: noIssue,
        },
      }
    );
  const result =
    await evaluateGuestJourneyRuntimeTick(
      mock.prisma,
      context,
      {
        now: new Date(
          "2026-08-25T12:01:00.000Z"
        ),
        dependencies: {
          verifyScope: async () => ({
            version:
              "guest_journey_runtime_enforcement_v1",
            profile: "off",
            enforced: false,
            reason: "PROFILE_OFF",
            organizationIds: [],
            propertyIds: [],
          }),
          persistFailureIssue: noIssue,
          resolveFailureIssue: noIssue,
        },
      }
    );

  assert.equal(result.allowed, true);
  assert.equal(result.status, ApmsRuntimeStatus.OFF);
  assert.equal(
    result.preflightStatus,
    ApmsRuntimePreflightStatus.NOT_REQUIRED
  );
});

test("E13 enabled profile becomes ACTIVE only after read-only scope preflight passes", async () => {
  const mock = runtimePrismaMock();
  const context =
    await initializeGuestJourneyRuntimeState(
      mock.prisma,
      shadowOnlyEnvironment(),
      {
        bootId: "boot-active",
        dependencies: {
          persistFailureIssue: noIssue,
        },
      }
    );
  const result =
    await evaluateGuestJourneyRuntimeTick(
      mock.prisma,
      context,
      {
        dependencies: {
          verifyScope: async () => ({
            version:
              "guest_journey_runtime_enforcement_v1",
            profile: "shadow_only",
            enforced: true,
            reason: "SCOPE_VERIFIED",
            organizationIds: ["org-secret-1"],
            propertyIds: ["property-secret-1"],
          }),
          persistFailureIssue: noIssue,
          resolveFailureIssue: noIssue,
        },
      }
    );

  assert.equal(result.allowed, true);
  assert.equal(result.status, ApmsRuntimeStatus.ACTIVE);
  assert.equal(
    result.preflightStatus,
    ApmsRuntimePreflightStatus.PASSED
  );
});

test("E13 scope failure blocks every enterprise stage and stores only a sanitized error", async () => {
  const mock = runtimePrismaMock();
  const context =
    await initializeGuestJourneyRuntimeState(
      mock.prisma,
      shadowOnlyEnvironment(),
      {
        bootId: "boot-blocked",
        dependencies: {
          persistFailureIssue: noIssue,
        },
      }
    );
  const result =
    await evaluateGuestJourneyRuntimeTick(
      mock.prisma,
      context,
      {
        dependencies: {
          verifyScope: async () => {
            throw new Error(
              "GUEST_JOURNEY_RUNTIME_PROPERTY_SCOPE_NOT_FOUND:property-secret-1"
            );
          },
          persistFailureIssue: noIssue,
          resolveFailureIssue: noIssue,
        },
      }
    );
  const row = mock.latest();

  assert.equal(result.allowed, false);
  assert.equal(
    result.status,
    ApmsRuntimeStatus.BLOCKED
  );
  assert.equal(row?.status, ApmsRuntimeStatus.BLOCKED);
  assert.doesNotMatch(
    String(row?.lastPreflightErrorMessage),
    /property-secret-1/
  );
});

test("E13 heartbeat is idempotent and never mutates config fingerprint", async () => {
  const mock = runtimePrismaMock();
  const context =
    await initializeGuestJourneyRuntimeState(
      mock.prisma,
      shadowOnlyEnvironment(),
      {
        bootId: "boot-heartbeat",
        dependencies: {
          persistFailureIssue: noIssue,
        },
      }
    );
  const before = mock.latest()?.configFingerprint;

  assert.equal(
    await recordGuestJourneyRuntimeHeartbeat(
      mock.prisma,
      context,
      new Date(
        "2026-08-25T12:02:00.000Z"
      )
    ),
    true
  );
  assert.equal(
    await recordGuestJourneyRuntimeHeartbeat(
      mock.prisma,
      context,
      new Date(
        "2026-08-25T12:03:00.000Z"
      )
    ),
    true
  );
  assert.equal(mock.latest()?.configFingerprint, before);
});

test("E13 hashed scope membership supports property and organization canaries", () => {
  const runtime = {
    activationProfile: "shadow_only",
    organizationScopeHashes: [
      hashGuestJourneyRuntimeScopeId(
        "organization",
        "org-1"
      ),
    ],
    propertyScopeHashes: [
      hashGuestJourneyRuntimeScopeId(
        "property",
        "property-2"
      ),
    ],
  };

  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      runtime,
      {
        organizationId: "org-1",
        propertyId: "property-1",
      }
    ),
    true
  );
  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      runtime,
      {
        organizationId: "org-2",
        propertyId: "property-2",
      }
    ),
    true
  );
  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      runtime,
      {
        organizationId: "org-2",
        propertyId: "property-3",
      }
    ),
    false
  );
});


test("E13 shared runtime issue recovers only after all failed replicas are stale or absent", async () => {
  const queries: any[] = [];
  let freshFailureCount = 1;
  const prisma = {
    apmsRuntimeState: {
      async count(args: any) {
        queries.push(args);
        return freshFailureCount;
      },
    },
  } as unknown as PrismaClient;
  const now = new Date(
    "2026-08-25T12:00:00.000Z"
  );
  const identity =
    buildGuestJourneyRuntimeIdentity(
      {
        NODE_ENV: "test",
        RAILWAY_SERVICE_NAME:
          "reservation-worker",
      },
      "boot-recovery"
    );

  assert.equal(
    await isGuestJourneyRuntimeFailureRecoveryEligible(
      prisma,
      identity,
      now
    ),
    false
  );

  freshFailureCount = 0;

  assert.equal(
    await isGuestJourneyRuntimeFailureRecoveryEligible(
      prisma,
      identity,
      now
    ),
    true
  );

  assert.equal(queries.length, 2);
  assert.equal(
    queries[0].where.runtimeName,
    "GUEST_JOURNEY"
  );
  assert.equal(
    queries[0].where.environment,
    "test"
  );
  assert.equal(
    queries[0].where.serviceName,
    "reservation-worker"
  );
  assert.equal(
    queries[0].where.lastHeartbeatAt.gte.toISOString(),
    "2026-08-25T11:59:00.000Z"
  );
  assert.deepEqual(
    queries[0].where.OR,
    [
      {
        status: {
          in: [
            ApmsRuntimeStatus.BLOCKED,
            ApmsRuntimeStatus.ERROR,
          ],
        },
      },
      {
        preflightStatus:
          ApmsRuntimePreflightStatus.FAILED,
      },
    ]
  );
});
