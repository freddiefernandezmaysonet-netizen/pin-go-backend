import assert from "node:assert/strict";
import test from "node:test";
import { deliverMfaOtp } from "./mfa-otp-delivery.js";

test("E2 delivery is permanently mock/no-send", async () => {
  const result = await deliverMfaOtp({
    type: "EMAIL",
    destination: "host@example.com",
    code: "123456",
    expiresInMinutes: 5,
  });
  assert.deepEqual(result, { delivered: false, mode: "MOCK" });
});
