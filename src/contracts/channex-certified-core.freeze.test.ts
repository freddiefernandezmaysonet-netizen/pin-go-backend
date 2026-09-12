import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const CERTIFIED_CORE_SHA256 =
  "85190e2aef52c2b4a00d40972bf66f696647f3977b99813fff1fe8019bd2d7bb";
const CERTIFIED_CORE_FILE_COUNT = 124;

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

function certifiedCoreFingerprint() {
  const files = [...walk("prisma"), ...walk("src")]
    .filter(isCertifiedCoreFile)
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

test("the Channex-certified core remains byte-for-byte frozen", () => {
  const fingerprint = certifiedCoreFingerprint();

  assert.equal(fingerprint.files.length, CERTIFIED_CORE_FILE_COUNT);
  assert.equal(
    fingerprint.sha256,
    CERTIFIED_CORE_SHA256,
    "A certified Channex file changed. Restore it or perform an explicitly authorized recertification review."
  );
});
