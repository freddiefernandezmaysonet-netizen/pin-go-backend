import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTtlockCallbackCanary,
  parseTtlockGatewayStateCallback,
} from "./ttlock-callback.routes";

const token = "callback-secret-123";

test("TTLock callback canary fails closed when token is not configured", () => {
  const result = evaluateTtlockCallbackCanary({
    expectedToken: "",
    receivedToken: token,
    contentType: "application/x-www-form-urlencoded",
    body: { lockId: "123" },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, 503);
});

test("TTLock callback canary rejects invalid token before parsing payload", () => {
  const result = evaluateTtlockCallbackCanary({
    expectedToken: token,
    receivedToken: "wrong-token",
    contentType: "application/x-www-form-urlencoded",
    body: { keyboardPwd: "should-never-matter" },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, 401);
});

test("TTLock callback canary rejects non-form payloads", () => {
  const result = evaluateTtlockCallbackCanary({
    expectedToken: token,
    receivedToken: token,
    contentType: "application/json",
    body: { lockId: "123" },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, 415);
});

test("TTLock callback canary rejects empty form payload", () => {
  const result = evaluateTtlockCallbackCanary({
    expectedToken: token,
    receivedToken: token,
    contentType: "application/x-www-form-urlencoded",
    body: {},
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, 400);
});

test("TTLock callback canary accepts authenticated form and returns safe evidence", () => {
  const result = evaluateTtlockCallbackCanary({
    expectedToken: token,
    receivedToken: token,
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    body: {
      lockId: "123",
      gatewayId: "456",
      recordType: "7",
      lockDate: "1700000000000",
      keyboardPwd: "998877",
      username: "guest@example.com",
    },
  });

  assert.equal(result.accepted, true);

  if (!result.accepted) {
    assert.fail("expected callback to be accepted");
  }

  assert.equal(result.status, 200);
  assert.equal(result.body, "success");
  assert.equal(result.metadata.lockId, "123");
  assert.equal(result.metadata.gatewayId, "456");
  assert.equal(result.metadata.recordType, "7");
  assert.equal("keyboardPwd" in result.metadata, false);
  assert.equal("username" in result.metadata, false);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});


test("gateway state callback accepts offline and online without provider calls", () => {
  const offline = parseTtlockGatewayStateCallback({
    gatewayId: "2046625",
    isOnline: "0",
    notifyType: "2",
    serverDate: "1790520000000",
  });

  assert.equal(offline?.gatewayId, 2046625);
  assert.equal(offline?.isOnline, false);
  assert.equal(
    offline?.occurredAt.getTime(),
    1790520000000
  );

  const online = parseTtlockGatewayStateCallback({
    gatewayId: "2046625",
    isOnline: "1",
    notifyType: "2",
    serverDate: null,
  });

  assert.equal(online?.gatewayId, 2046625);
  assert.equal(online?.isOnline, true);

  assert.equal(
    parseTtlockGatewayStateCallback({
      gatewayId: "2046625",
      isOnline: "0",
      notifyType: "1",
    }),
    null
  );

  assert.equal(
    parseTtlockGatewayStateCallback({
      gatewayId: "not-a-number",
      isOnline: "0",
      notifyType: "2",
    }),
    null
  );
});
