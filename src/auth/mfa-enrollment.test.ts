import assert from "node:assert/strict";
import test from "node:test";
import { applyEnrollmentVerification, prepareEnrollment } from "./mfa-enrollment.js";

test("email enrollment is bound to account email", () => {
  assert.deepEqual(prepareEnrollment({ userId: "u1", accountEmail: " Host@Example.com ", type: "EMAIL" }), {
    userId: "u1", type: "EMAIL", destination: "host@example.com", status: "PENDING",
  });
});

test("email enrollment rejects a different destination", () => {
  assert.throws(() => prepareEnrollment({ userId: "u1", accountEmail: "host@example.com", type: "EMAIL", destination: "attacker@example.com" }), /EMAIL_MUST_MATCH_ACCOUNT/);
});

test("SMS enrollment requires explicit destination", () => {
  assert.throws(() => prepareEnrollment({ userId: "u1", accountEmail: "host@example.com", type: "SMS" }), /SMS_DESTINATION_REQUIRED/);
});

test("SMS enrollment normalizes PR US numbers", () => {
  assert.deepEqual(prepareEnrollment({ userId: "u1", accountEmail: "host@example.com", type: "SMS", destination: "787 555 1212" }), {
    userId: "u1", type: "SMS", destination: "+17875551212", status: "PENDING",
  });
});

test("factor stays pending after failed OTP", () => {
  const factor = prepareEnrollment({ userId: "u1", accountEmail: "host@example.com", type: "EMAIL" });
  assert.equal(applyEnrollmentVerification(factor, false).status, "PENDING");
});

test("factor becomes verified only after successful OTP", () => {
  const factor = prepareEnrollment({ userId: "u1", accountEmail: "host@example.com", type: "EMAIL" });
  assert.equal(applyEnrollmentVerification(factor, true).status, "VERIFIED");
});
