import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./mobile-access-revocation-sidecar.service.ts", import.meta.url), "utf8");
const brain = await fs.readFile(new URL("../services/ttlock/ttlock.brain.ts", import.meta.url), "utf8");

test("sidecar targets only pending or active credentials for the AccessGrant", () => {
  assert.match(source, /accessGrantId: input\.accessGrantId/);
  assert.match(source, /status: \{ in: \["PENDING", "ACTIVE"\] \}/);
});

test("sidecar isolates individual mobile revoke failures", () => {
  assert.match(source, /try \{/);
  assert.match(source, /catch \{/);
  assert.match(source, /failed\.push\(credential\.id\)/);
  assert.match(source, /RECOVERY_REQUIRED/);
});

test("sidecar reports clean completion separately", () => {
  assert.match(source, /status: "REVOKED"/);
  assert.match(source, /failed\.length === 0/);
});

test("canonical TTLock passcode brain is not yet coupled to mobile sidecar", () => {
  assert.doesNotMatch(brain, /reconcileMobileAccessRevocationSidecar/);
});
