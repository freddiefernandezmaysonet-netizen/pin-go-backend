from pathlib import Path
import re

BRANCH_HELPERS = (
    ".github/workflows/e13-authorized-premerge-fix.yml",
    ".github/workflows/e13-authorized-premerge-fix-v2.yml",
    ".github/workflows/e13-authorized-premerge-fix-v3.yml",
    ".github/scripts/e13_authorized_patch.py",
)


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    Path(path).write_text(value, encoding="utf-8")


def replace_once(value: str, old: str, new: str, label: str) -> str:
    count = value.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return value.replace(old, new, 1)


def regex_once(
    value: str,
    pattern: str,
    replacement: str,
    label: str,
    flags: int = 0,
) -> str:
    updated, count = re.subn(pattern, replacement, value, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected one regex match, found {count}")
    return updated


# A. Preserve the shared runtime issue while any failed replica is still fresh.
service_path = "src/services/guest-journey-runtime-state.service.ts"
service = read(service_path)

helper = '''export async function isGuestJourneyRuntimeFailureRecoveryEligible(
  prisma: Pick<PrismaClient, "apmsRuntimeState">,
  identity: GuestJourneyRuntimeIdentity,
  now: Date,
  staleAfterMs: number = GUEST_JOURNEY_RUNTIME_STALE_AFTER_MS
): Promise<boolean> {
  const freshFrom = new Date(
    now.getTime() - staleAfterMs
  );
  const freshFailureCount =
    await prisma.apmsRuntimeState.count({
      where: {
        runtimeName: identity.runtimeName,
        environment: identity.environment,
        serviceName: identity.serviceName,
        lastHeartbeatAt: {
          gte: freshFrom,
        },
        OR: [
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
        ],
      },
    });

  return freshFailureCount === 0;
}

'''

if "export async function isGuestJourneyRuntimeFailureRecoveryEligible(" not in service:
    service = replace_once(
        service,
        "async function resolveRuntimeFailureIssue(\n",
        helper + "async function resolveRuntimeFailureIssue(\n",
        "runtime recovery helper insertion",
    )

if "const recoveryEligible =" not in service:
    service = replace_once(
        service,
        '''  if (!existing || existing.workflowState === "RESOLVED") return existing;

  const issue = await upsertOperationalIssue(prisma, {
''',
        '''  if (!existing || existing.workflowState === "RESOLVED") return existing;

  const recoveryEligible =
    await isGuestJourneyRuntimeFailureRecoveryEligible(
      prisma,
      context.identity,
      now
    );

  if (!recoveryEligible) {
    return existing;
  }

  const issue = await upsertOperationalIssue(prisma, {
''',
        "runtime recovery guard",
    )

write(service_path, service)

# Focused unit test for one healthy replica versus another fresh/stale failed replica.
service_test_path = "src/services/guest-journey-runtime-state.service.test.ts"
service_test = read(service_test_path)

if "isGuestJourneyRuntimeFailureRecoveryEligible," not in service_test:
    service_test = replace_once(
        service_test,
        '''  initializeGuestJourneyRuntimeState,
  isGuestJourneyRuntimeScopeMatch,
''',
        '''  initializeGuestJourneyRuntimeState,
  isGuestJourneyRuntimeFailureRecoveryEligible,
  isGuestJourneyRuntimeScopeMatch,
''',
        "runtime test helper import",
    )

replica_test_name = (
    'test("E13 shared runtime issue recovers only after all failed replicas '
    'are stale or absent"'
)
if replica_test_name not in service_test:
    service_test += '''

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
'''

write(service_test_path, service_test)

# B. The E13 status/preflight write is the worker's only authoritative heartbeat.
worker_path = "src/workers/reservation.worker.ts"
worker = read(worker_path)

worker = worker.replace(
    "  recordGuestJourneyRuntimeHeartbeat,\n",
    "",
    1,
)

if "recordGuestJourneyRuntimeHeartbeat" in worker:
    worker = regex_once(
        worker,
        r'''\n    if \(guestJourneyRuntimeContext\) \{
      try \{
        const heartbeatPersisted =
          await recordGuestJourneyRuntimeHeartbeat\(
[\s\S]*?
    \}

(?=    try \{
      await processPasscodeResyncs\(now\);)''',
        "\n",
        "worker pre-gate heartbeat removal",
    )

if "recordGuestJourneyRuntimeHeartbeat" in worker:
    raise SystemExit("worker still contains a pre-gate heartbeat reference")

write(worker_path, worker)

# C. A stale runtime-generated issue remains evidence, but not current ERROR health.
health_path = "src/apms/mission-control-runtime-health.e13.ts"
health = read(health_path)

if "const currentHealthIssues =" not in health:
    health = replace_once(
        health,
        '''  const runtimeFailure = freshRuntimes.some(
    (runtime) =>
      runtime.status === "BLOCKED" ||
      runtime.status === "ERROR" ||
      runtime.preflightStatus === "FAILED"
  );
  const hasCriticalIssue =
    input.allVisibilityCurrentIssues.some(
''',
        '''  const runtimeFailure = freshRuntimes.some(
    (runtime) =>
      runtime.status === "BLOCKED" ||
      runtime.status === "ERROR" ||
      runtime.preflightStatus === "FAILED"
  );
  const currentHealthIssues =
    input.allVisibilityCurrentIssues.filter(
      (issue) => {
        const runtimeFailureIssue =
          issue.issueCode ===
            "GUEST_JOURNEY_RUNTIME_BLOCKED" &&
          issue.engine === "GUEST_JOURNEY";

        return (
          !runtimeFailureIssue ||
          runtimeFailure
        );
      }
    );
  const hasCriticalIssue =
    currentHealthIssues.some(
''',
        "native health issue filter",
    )
    health = replace_once(
        health,
        '''  const hasHostAction =
    input.allVisibilityCurrentIssues.some(
''',
        '''  const hasHostAction =
    currentHealthIssues.some(
''',
        "native health host-action source",
    )
    health = replace_once(
        health,
        '''  const issueHealth = projectCurrentIssueHealth(
    input.allVisibilityCurrentIssues
  );
''',
        '''  const issueHealth = projectCurrentIssueHealth(
    currentHealthIssues
  );
''',
        "native health projection source",
    )

write(health_path, health)

health_test_path = "src/apms/mission-control-runtime-health.e13.test.ts"
health_test = read(health_test_path)

if 'test("E13 stale runtime issue preserves evidence but current health becomes PAUSED"' not in health_test:
    health_test += '''

test("E13 stale runtime issue preserves evidence but current health becomes PAUSED", () => {
  const result = derive({
    runtimeRows: [
      runtime({
        lastHeartbeatAt: new Date(
          NOW.getTime() - 61_000
        ),
      }),
    ],
    issues: [
      issue({
        issueCode:
          "GUEST_JOURNEY_RUNTIME_BLOCKED",
        visibility: "DEVELOPER",
        severity: "CRITICAL",
        workflowState:
          "ACTION_REQUIRED",
        actionRequired: true,
        canAutoResolve: false,
        autoResolveStatus:
          "NOT_SUPPORTED",
      }),
    ],
  });

  assert.equal(
    result.autopilotStatus,
    "PAUSED"
  );
  assert.equal(
    result.engineHealth.find(
      (entry) =>
        entry.engine === "GUEST_JOURNEY"
    )?.status,
    "WARNING"
  );
});

test("E13 fresh failed runtime and its durable issue remain ERROR", () => {
  const result = derive({
    runtimeRows: [
      runtime({
        status: "BLOCKED",
        preflightStatus: "FAILED",
      }),
    ],
    issues: [
      issue({
        issueCode:
          "GUEST_JOURNEY_RUNTIME_BLOCKED",
        visibility: "DEVELOPER",
        severity: "CRITICAL",
        workflowState:
          "ACTION_REQUIRED",
        actionRequired: true,
        canAutoResolve: false,
        autoResolveStatus:
          "NOT_SUPPORTED",
      }),
    ],
  });

  assert.equal(
    result.autopilotStatus,
    "ERROR"
  );
  assert.equal(
    result.engineHealth.find(
      (entry) =>
        entry.engine === "GUEST_JOURNEY"
    )?.status,
    "ERROR"
  );
});
'''

write(health_test_path, health_test)

# D. Restore complete migration history execution in the E1 ephemeral PostgreSQL job.
e1_path = ".github/workflows/guest-journey-enterprise-e1-certification.yml"
e1 = read(e1_path)

if "Validate E13 migration history without applying migrations" in e1:
    e1 = regex_once(
        e1,
        r'''      - name: Apply complete migration history to empty PostgreSQL
        if: github\.head_ref != 'agent/apms-enterprise-guest-journey-e13-runtime-truth' && github\.ref_name != 'agent/apms-enterprise-guest-journey-e13-runtime-truth'
        run: npx prisma migrate deploy --schema prisma/schema\.prisma

      - name: Validate E13 migration history without applying migrations
        if: github\.head_ref == 'agent/apms-enterprise-guest-journey-e13-runtime-truth' \|\| github\.ref_name == 'agent/apms-enterprise-guest-journey-e13-runtime-truth'
        run: >-
          npx prisma migrate diff
          --from-empty
          --to-schema-datamodel prisma/schema\.prisma
          --script
''',
        '''      - name: Apply complete migration history to empty PostgreSQL
        run: npx prisma migrate deploy --schema prisma/schema.prisma
''',
        "E1 full ephemeral migration history",
    )

if "Validate E13 migration history without applying migrations" in e1:
    raise SystemExit("E1 migration bypass is still present")

write(e1_path, e1)

# Pin all four corrections in the E13 source contract without brittle edits.
contract_path = "src/services/guest-journey-e13-runtime-truth.contract.test.ts"
contract = read(contract_path)

if 'test("E13 pre-merge hardening pins replica recovery, heartbeat ordering, stale health, and full ephemeral migrations"' not in contract:
    contract += '''

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
'''

write(contract_path, contract)

# The helper is intentionally absent from the final branch tree.
for helper_path in BRANCH_HELPERS:
    helper = Path(helper_path)
    if helper.exists():
        helper.unlink()
