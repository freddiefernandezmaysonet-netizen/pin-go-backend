import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Authorized recertification: PR #333, 2026-10-03 (Puerto Rico).
// Three ARI files receive only reviewed strict-typing compatibility changes.
// The other 122 original files retain their independently verified fingerprint;
// the full guard also includes the previously certified conflict module.
const CERTIFIED_CORE_SHA256 =
  "99ce90a53077a01073d1687c1f29f36bb53c7590b72829c5290761e9f98cf6b4";
const CERTIFIED_CORE_FILE_COUNT = 126;
const ORIGINAL_CORE_SHA256 =
  "3f3548c396454453f798cd46e2ba7aeac35d1d705ce59b2392b7162f7ed41666";
const ADDED_CONFLICT_MODULE = "src/services/channex-availability-conflict.service.ts";
const RECERTIFIED_ARI_FILES = new Map([
  ["src/pms/outbound/channex-ari-outbox.service.ts", "7e03d01c275bd926fe8da15c277e72e09b486fe510ddaeee24218d17e7be6aaa"],
  ["src/pms/outbound/channex-ari-rates-restrictions-snapshot.policy.ts", "8b2f92b794de3bc503073c0f8ecd9d87bf81f9e18bfce265a051753ce5b6ca60"],
  ["src/pms/outbound/channex-ari-reservation-producer.service.ts", "1e41e2681d41d53ef375513e2d4a1848d48b46e1707c3e272cd661464da6301f"],
]);

const CHANNEX_PRODUCTION_TRANSPORT_BOUNDARY_FILES = new Set([
  "src/distribution/ota-connection-center.config.test.ts",
  "src/distribution/ota-connection-center.config.ts",
  "src/lib/channex-production-runtime-boundary.contract.test.ts",
  "src/lib/channex-runtime-transport.policy.test.ts",
  "src/lib/channex-runtime-transport.policy.ts",
  "src/routes/dashboard.channex-full-sync.route.test.ts",
  "src/routes/dashboard.channex-full-sync.route.ts",
  "src/routes/org.pms.routes.ts",
]);

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? walk(filePath) : [filePath];
  });
}

function isCertifiedCoreFile(filePath: string): boolean {
  return (
    CHANNEX_PRODUCTION_TRANSPORT_BOUNDARY_FILES.has(filePath) ||
    filePath === "prisma/channex-ari.prisma" ||
    filePath === "src/pms/adapters/channex.adapter.ts" ||
    filePath === "src/pms/adapters/channex.adapter.test.ts" ||
    filePath === "src/pms/adapters/types.ts" ||
    filePath.startsWith("src/pms/ingest/channex-") ||
    filePath === "src/pms/ingest/webhook.routes.ts" ||
    filePath === "src/pms/ingest/webhook.routes.test.ts" ||
    filePath.startsWith("src/pms/outbound/channex-") ||
    filePath.startsWith("src/workers/channex-") ||
    filePath.startsWith("src/services/channex-") ||
    (filePath.startsWith("src/scripts/") &&
      path.posix.basename(filePath).includes("channex"))
  );
}

function certifiedCoreFingerprint(excludedPaths: ReadonlySet<string> = new Set()) {
  const files = [...walk("prisma"), ...walk("src")]
    .filter(isCertifiedCoreFile)
    .filter((filePath) => !excludedPaths.has(filePath))
    .sort();
  const hash = crypto.createHash("sha256");

  for (const filePath of files) {
    hash.update(filePath);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }

  return { files, sha256: hash.digest("hex") };
}

test("the 122 original Channex files outside the authorized ARI review remain unchanged", () => {
  const fingerprint = certifiedCoreFingerprint(new Set([ADDED_CONFLICT_MODULE, ...RECERTIFIED_ARI_FILES.keys()]));
  assert.equal(fingerprint.files.length, 122);
  assert.equal(fingerprint.sha256, ORIGINAL_CORE_SHA256);
});

test("the three recertified ARI files match their exact reviewed content", () => {
  for (const [file, expected] of RECERTIFIED_ARI_FILES) {
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), expected, file);
  }
});

test("the Channex-certified core remains byte-for-byte frozen", () => {
  const fingerprint = certifiedCoreFingerprint();

  assert.equal(fingerprint.files.length, CERTIFIED_CORE_FILE_COUNT);
  assert.equal(
    fingerprint.sha256,
    CERTIFIED_CORE_SHA256,
    "A certified Channex file changed. Restore it or perform an explicitly authorized recertification review."
  );
});
