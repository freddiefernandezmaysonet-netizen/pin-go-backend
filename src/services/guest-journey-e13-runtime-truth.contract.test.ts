import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(
    new URL(relativePath, import.meta.url),
    "utf8"
  );
}

const worker = source(
  "../workers/reservation.worker.ts"
);
const runtimeService = source(
  "./guest-journey-runtime-state.service.ts"
);
const healthProjection = source(
  "../apms/mission-control-runtime-health.e13.ts"
);
const propertyRoute = source(
  "../routes/dashboard.properties.route.ts"
);
const server = source("../server.ts");
const schema = source(
  "../../prisma/schema.prisma"
);
const migration = source(
  "../../prisma/migrations/20260825120000_add_apms_runtime_truth/migration.sql"
);
const workflow = source(
  "../../.github/workflows/guest-journey-enterprise-e13-certification.yml"
);

test("E13 schema persists durable runtime truth without raw tenant/property IDs", () => {
  const model = schema.match(
    /model ApmsRuntimeState \{[\s\S]*?\n\}/
  )?.[0];

  assert.ok(model);
  for (const field of [
    "runtimeKey",
    "runtimeName",
    "environment",
    "serviceName",
    "instanceId",
    "bootId",
    "deploymentSha",
    "deploymentId",
    "activationProfile",
    "enabledStages",
    "configFingerprint",
    "scopeFingerprint",
    "organizationScopeHashes",
    "propertyScopeHashes",
    "organizationScopeCount",
    "propertyScopeCount",
    "status",
    "preflightStatus",
    "lastPreflightAt",
    "lastPreflightErrorCode",
    "lastPreflightErrorMessage",
    "startedAt",
    "lastHeartbeatAt",
  ]) {
    assert.match(
      model,
      new RegExp(`\\b${field}\\b`)
    );
  }

  assert.doesNotMatch(
    model,
    /\borganizationId\b|\bpropertyId\b/
  );
  assert.match(
    model,
    /@@index\(\[runtimeName, environment, serviceName, lastHeartbeatAt\]\)/
  );
  assert.match(
    model,
    /@@index\(\[configFingerprint, lastHeartbeatAt\]\)/
  );
});

test("E13 migration is additive and matches the durable runtime contract", () => {
  assert.match(
    migration,
    /CREATE TYPE "ApmsRuntimeStatus"/
  );
  assert.match(
    migration,
    /CREATE TYPE "ApmsRuntimePreflightStatus"/
  );
  assert.match(
    migration,
    /CREATE TABLE "ApmsRuntimeState"/
  );
  assert.match(
    migration,
    /organizationScopeHashes/
  );
  assert.match(
    migration,
    /propertyScopeHashes/
  );
  assert.doesNotMatch(
    migration,
    /\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i
  );
});

test("E13 resolves the live E11 profile during controlled startup and preserves legacy work", () => {
  assert.match(
    worker,
    /initializeGuestJourneyRuntimeState\(/
  );
  assert.match(
    worker,
    /applyGuestJourneyActivationConfig\(/
  );
  assert.match(
    worker,
    /evaluateGuestJourneyRuntimeTick\(/
  );
  assert.doesNotMatch(
    worker,
    /resolveGuestJourneyActivationControlPlaneConfig\(\)\s*;/
  );

  const legacyCheckin = worker.indexOf(
    "await processCheckins(now)"
  );
  const runtimeGate = worker.indexOf(
    "evaluateGuestJourneyRuntimeTick("
  );

  assert.ok(legacyCheckin >= 0);
  assert.ok(runtimeGate > legacyCheckin);
  assert.doesNotMatch(
    worker,
    /ENV DATABASE_URL|process\.env\.DATABASE_URL\s*\?/
  );
});

test("E13 runtime truth performs no provider action", () => {
  const combined =
    runtimeService + "\n" + healthProjection;

  assert.doesNotMatch(
    combined,
    /from\s+["'][^"']*(ttlock|stripe|twilio|channex|mailer|messaging)[^"']*["']/i
  );
  assert.doesNotMatch(
    combined,
    /\b(activateGrant|deactivateGrant|sendSms|sendEmail|charge|refund|transfer|fetch|axios)\s*\(/i
  );
});

test("E13 Mission Control consumes all visibility for health and returns HOST items only", () => {
  assert.match(
    propertyRoute,
    /allVisibilityCurrentIssueRows/
  );
  assert.match(
    propertyRoute,
    /prisma\.apmsRuntimeState\.findMany/
  );
  assert.match(
    propertyRoute,
    /deriveMissionControlNativeHealth/
  );
  assert.match(
    propertyRoute,
    /visibility:\s*"HOST"/
  );
  assert.match(
    propertyRoute,
    /operationalItems,\s*\n\s*currentOperationalState/
  );
  assert.match(
    propertyRoute,
    /autopilotStatus:\s*\n\s*nativeHealth\.autopilotStatus/
  );
  assert.match(
    propertyRoute,
    /activityHistory,\s*\n\s*recentAuditEntries: activityHistory/
  );
});

test("E13 removes the transitional E12 middleware from source and server wiring", () => {
  assert.doesNotMatch(
    server,
    /missionControlCurrentStateCutoverMiddleware/
  );
  assert.equal(
    existsSync(
      new URL(
        "../routes/dashboard.mission-control-current-state.e12.middleware.ts",
        import.meta.url
      )
    ),
    false
  );
});

test("E13 certification never applies migrations or calls providers", () => {
  assert.match(workflow, /prisma validate/);
  assert.match(workflow, /prisma generate/);
  assert.doesNotMatch(
    workflow,
    /migrate deploy|migrate dev|db push|TTLock|Stripe|Twilio|Channex/i
  );
});


test("E13 pre-merge hardening pins replica recovery, heartbeat ordering, stale health, and full ephemeral migrations", () => {
  const e1Workflow = source(
    "../../.github/workflows/guest-journey-enterprise-e1-certification.yml"
  );

  assert.match(
    runtimeService,
    /isGuestJourneyRuntimeFailureRecoveryEligible/
  );
  assert.match(
    runtimeService,
    /lastHeartbeatAt:\s*\{\s*gte:\s*freshFrom/
  );
  assert.match(
    runtimeService,
    /if \(!recoveryEligible\) \{\s*return existing;/
  );
  assert.doesNotMatch(
    worker,
    /recordGuestJourneyRuntimeHeartbeat/
  );
  assert.match(
    healthProjection,
    /const currentHealthIssues =/
  );
  assert.match(
    healthProjection,
    /GUEST_JOURNEY_RUNTIME_BLOCKED/
  );
  assert.match(
    e1Workflow,
    /npx prisma migrate deploy --schema prisma\/schema\.prisma/
  );
  assert.doesNotMatch(
    e1Workflow,
    /Validate E13 migration history without applying migrations/
  );
});
