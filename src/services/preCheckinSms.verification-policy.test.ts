import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPreCheckinMessage,
  shouldIncludePreCheckinVerification,
} from "./preCheckinSms.service";

test("pre-checkin verification is omitted when identity is completed", () => {
  assert.equal(
    shouldIncludePreCheckinVerification({
      guestToken: "guest-token",
      verificationStatus: "COMPLETED",
      guestAgreementSnapshot: { requiresIdentityVerification: true },
    }),
    false
  );
});

test("pre-checkin verification is omitted when identity is not required", () => {
  assert.equal(
    shouldIncludePreCheckinVerification({
      guestToken: "guest-token",
      verificationStatus: "PENDING",
      guestAgreementSnapshot: { requiresIdentityVerification: false },
    }),
    false
  );
});

test("pre-checkin verification is omitted when verification status is NOT_REQUIRED", () => {
  assert.equal(
    shouldIncludePreCheckinVerification({
      guestToken: "guest-token",
      verificationStatus: "NOT_REQUIRED",
      guestAgreementSnapshot: { requiresIdentityVerification: true },
    }),
    false
  );
});

test("pre-checkin verification remains when identity is still pending", () => {
  assert.equal(
    shouldIncludePreCheckinVerification({
      guestToken: "guest-token",
      verificationStatus: "PENDING",
      guestAgreementSnapshot: { requiresIdentityVerification: true },
    }),
    true
  );
});

test("completed verification message contains no verification instruction", () => {
  const body = buildPreCheckinMessage({
    guestName: "Guest",
    propertyName: "Casa Test",
    checkInTime: "04:00 PM",
    address: "123 Main St",
    mapsLink: "https://maps.example/test",
    verifyLink: null,
    language: "es",
  });

  assert.doesNotMatch(body.toLowerCase(), /verific/);
  assert.doesNotMatch(body, /guest\/verify/i);
  assert.match(body, /Te esperamos\./);
});
