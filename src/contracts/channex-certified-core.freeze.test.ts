import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const CERTIFIED_CORE_SHA256 =
  "085477095e14d087715407c3db7843e6b49a284e80f9a5a91a9a9a407148334b";
const CERTIFIED_CORE_FILE_COUNT = 116;

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? walk(filePath) : [filePath];
  });
}

function isCertifiedCoreFile(filePath: string): boolean {
  return (
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
