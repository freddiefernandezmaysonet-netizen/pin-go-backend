import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Authorized recertification review: PR #333, 2026-10-02.
// Only the transactional availability-conflict module is added. The previous
// 125-file core retains its exact certified fingerprint in a separate guard.
const CERTIFIED_CORE_SHA256 =
  "ce1dcb2c04d27323efbd8dbff1928f09b781bf4c9af8215bca0b754eb2fbe43d";
const CERTIFIED_CORE_FILE_COUNT = 126;
const ORIGINAL_CORE_SHA256 =
  "4153a95b6964b7bbc83f8eacb0debefba8cb2fe65b6ea3261e370e8711134754";
const ADDED_CONFLICT_MODULE = "src/services/channex-availability-conflict.service.ts";

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

test("the original 125-file Channex core remains unchanged after the authorized addition", () => {
  const fingerprint = certifiedCoreFingerprint(new Set([ADDED_CONFLICT_MODULE]));
  assert.equal(fingerprint.files.length, 125);
  assert.equal(fingerprint.sha256, ORIGINAL_CORE_SHA256);
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
