import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE_FILES = [
  "guest-access-admission-fence.policy.e14.js",
  "guest-access-admission-fence.service.e14.js",
  "guest-access-readiness-mission-control.policy.e14.js",
  "guest-access-readiness-mission-control.service.e14.js",
  "guest-access-admission-safety-cycle.e14.js",
];

test("E14 source has no direct provider client import or invocation", () => {
  const source = SOURCE_FILES
    .map((name) =>
      readFileSync(new URL(name, import.meta.url), "utf8")
    )
    .join("\n")
    .toLowerCase();

  for (const forbidden of [
    "ttlockgetpasscode",
    "ttlockdeletepasscode",
    "stripe.",
    "twilio",
    "channex",
    "axios.",
    "fetch(",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `unexpected provider boundary: ${forbidden}`
    );
  }
});

test("E14 reuses AccessGrant recovery fields and adds no schema dependency", () => {
  const source = readFileSync(
    new URL(
      "guest-access-admission-fence.service.e14.js",
      import.meta.url
    ),
    "utf8"
  );

  for (const field of [
    "recoveryOperation",
    "recoveryAttemptCount",
    "recoveryLastAttemptAt",
    "recoveryNextAttemptAt",
    "recoveryExhaustedAt",
  ]) {
    assert.equal(source.includes(field), true);
  }

  assert.equal(source.includes("provisioningLeaseToken"), false);
  assert.equal(source.includes("prisma/migrations"), false);
});

test("unknown physical-boundary failures fail closed as ambiguous", () => {
  const policy = readFileSync(
    new URL(
      "guest-access-admission-fence.policy.e14.js",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    policy,
    /GUEST_ACCESS_PROVISION_SAFE_TO_RETRY/
  );
  assert.match(
    policy,
    /\? "RETRYABLE"\s*:\s*"AMBIGUOUS"/
  );
});

test("Mission Control represents bounded recovery and refreshes reopened issue details", () => {
  const policy = readFileSync(
    new URL(
      "guest-access-readiness-mission-control.policy.e14.js",
      import.meta.url
    ),
    "utf8"
  );
  const service = readFileSync(
    new URL(
      "guest-access-readiness-mission-control.service.e14.js",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    policy,
    /GUEST_ACCESS_PROVISIONING_RECOVERY/
  );
  assert.match(policy, /AUTO_RESOLVING/);

  const reopenIndex = service.indexOf(
    "await reopenOperationalIssue("
  );
  const refreshIndex = service.indexOf(
    "await persistActiveProjection(",
    reopenIndex
  );

  assert.ok(reopenIndex >= 0);
  assert.ok(refreshIndex > reopenIndex);
});
