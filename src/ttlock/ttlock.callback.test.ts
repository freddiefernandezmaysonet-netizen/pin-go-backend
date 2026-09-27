import assert from "node:assert/strict";
import test from "node:test";

import {
  isTtlockCallbackContentType,
  normalizeTtlockCallbackForm,
  ttlockCallbackFingerprint,
  ttlockCallbackSafeMetadata,
  ttlockCallbackTokenMatches,
} from "./ttlock.callback";

test("TTLock callback token requires an exact constant-time-compatible match", () => {
  assert.equal(
    ttlockCallbackTokenMatches({
      expectedToken: "callback-secret-123",
      receivedToken: "callback-secret-123",
    }),
    true
  );

  assert.equal(
    ttlockCallbackTokenMatches({
      expectedToken: "callback-secret-123",
      receivedToken: "callback-secret-124",
    }),
    false
  );

  assert.equal(
    ttlockCallbackTokenMatches({
      expectedToken: "",
      receivedToken: "callback-secret-123",
    }),
    false
  );
});

test("TTLock callback accepts only application/x-www-form-urlencoded", () => {
  assert.equal(
    isTtlockCallbackContentType(
      "application/x-www-form-urlencoded; charset=UTF-8"
    ),
    true
  );

  assert.equal(
    isTtlockCallbackContentType("application/json"),
    false
  );
});

test("TTLock callback fingerprint is stable across form key order", () => {
  const left = normalizeTtlockCallbackForm({
    lockId: "123",
    recordType: "7",
    lockDate: "1700000000000",
  });

  const right = normalizeTtlockCallbackForm({
    lockDate: "1700000000000",
    lockId: "123",
    recordType: "7",
  });

  assert.equal(
    ttlockCallbackFingerprint(left),
    ttlockCallbackFingerprint(right)
  );
});

test("safe metadata exposes identifiers but never credential fields", () => {
  const form = normalizeTtlockCallbackForm({
    lockId: "123",
    gatewayId: "456",
    recordType: "7",
    lockDate: "1700000000000",
    serverDate: "1700000000500",
    keyboardPwd: "998877",
    username: "guest@example.com",
    records: "[{\"keyboardPwd\":\"998877\"}]",
  });

  const safe = ttlockCallbackSafeMetadata(form);

  assert.equal(safe.lockId, "123");
  assert.equal(safe.gatewayId, "456");
  assert.equal(safe.recordType, "7");
  assert.equal(safe.lockDate, "1700000000000");
  assert.equal(safe.serverDate, "1700000000500");

  assert.deepEqual(
    safe.keys,
    [
      "gatewayId",
      "keyboardPwd",
      "lockDate",
      "lockId",
      "recordType",
      "records",
      "serverDate",
      "username",
    ]
  );

  assert.equal("keyboardPwd" in safe, false);
  assert.equal("username" in safe, false);
  assert.equal("records" in safe, false);
});
