import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./mobile-access-grant-lifecycle.service.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");
const brain = await fs.readFile(new URL("../services/ttlock/ttlock.brain.ts", import.meta.url), "utf8");

test("AccessGrant bridge targets only pending or active mobile credentials", () => {
  assert.match(source, /accessGrantId: input\.accessGrantId/);
  assert.match(source, /status: \{ in: \["PENDING", "ACTIVE"\] \}/);
});

test("bridge awaits each revoke and therefore fails closed on first provider failure", () => {
  assert.match(source, /await input\.revokeCredential\(credential\.id\)/);
  assert.doesNotMatch(source, /catch\s*\(/);
});

test("bridge remains disconnected from production AccessGrant lifecycle", () => {
  assert.doesNotMatch(worker, /revokeMobileAccessForGrant/);
  assert.doesNotMatch(brain, /revokeMobileAccessForGrant/);
});
