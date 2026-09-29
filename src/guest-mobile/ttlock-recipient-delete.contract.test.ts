import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./ttlock-recipient-delete.service.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");

test("TTLock account deletion requires prior DELETE_PENDING authorization", () => {
  assert.match(source, /status !== "DELETE_PENDING"/);
  assert.match(source, /TTLOCK_RECIPIENT_DELETE_NOT_AUTHORIZED/);
});

test("provider delete happens before local credential tombstone", () => {
  const providerAt = source.indexOf("/v3/user/delete");
  const tombstoneAt = source.indexOf("tombstoneDeletedTTLockRecipient");
  assert.ok(providerAt >= 0 && tombstoneAt > providerAt);
});

test("provider delete failure preserves local identity for retry", () => {
  assert.match(source, /TTLOCK_RECIPIENT_DELETE_FAILED/);
  assert.match(source, /throw error/);
});

test("recipient deletion is not scheduled from reservation worker", () => {
  assert.doesNotMatch(worker, /deleteTTLockRecipientIdentity|evaluateTTLockRecipientRetention/);
});
