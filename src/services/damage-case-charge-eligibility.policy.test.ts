import assert from "node:assert/strict";
import test from "node:test";
import { DAMAGE_PAYMENT_AUTHORIZATION_VERSION, evaluateDamageChargeEligibility as evaluate } from "./damage-case-charge-eligibility.policy.js";
import type { DamageChargeEligibilityInput } from "./damage-case-charge-eligibility.policy.js";

function fixture(): DamageChargeEligibilityInput {
  return {
    now: new Date("2026-09-23T18:00:00Z"), checkOut: new Date("2026-09-23T11:00:00-04:00"),
    directBooking: true, protectionEnabled: true, protectionMode: "CARD_ON_FILE",
    organizationId: "synthetic-org", reservationId: "synthetic-reservation", damageCaseId: "synthetic-case",
    connectedAccountId: "synthetic-account", status: "GUEST_NOTIFIED", closedAt: null,
    guestResponse: "ACCEPTED", hostApprovedAt: new Date("2026-09-23T16:00:00Z"), hostApprovedByUserId: "synthetic-host",
    guestNotifiedAt: new Date("2026-09-23T16:01:00Z"), claimRevision: "revision-1",
    approvedAmountMinor: 10001, acceptedMaximumMinor: 20000, currency: "usd", maximumCurrency: "usd",
    authorization: {
      version: DAMAGE_PAYMENT_AUTHORIZATION_VERSION, action: "ACCEPT_AND_AUTHORIZE_PAYMENT",
      organizationId: "synthetic-org", reservationId: "synthetic-reservation", damageCaseId: "synthetic-case",
      connectedAccountId: "synthetic-account", claimRevision: "revision-1", amountMinor: 10001, currency: "usd",
      authorizedAt: new Date("2026-09-23T17:00:00Z"),
    },
  };
}

test("eligible policy is deterministic, does not mutate input, and returns no execution instruction", () => {
  const input = fixture();
  const before = structuredClone(input);
  Object.freeze(input.authorization);
  Object.freeze(input);
  for (let i = 0; i < 3; i++) assert.deepEqual(evaluate(input), { eligible: true, reason: "POLICY_ELIGIBLE" });
  assert.deepEqual(input, before);
});

const blockedCases: Array<[string, Partial<DamageChargeEligibilityInput>, string]> = [
  ["exact checkout", { now: fixture().checkOut }, "CHECKOUT_REQUIRED"],
  ["before checkout", { now: new Date("2026-09-23T14:00:00Z") }, "CHECKOUT_REQUIRED"],
  ["extended checkout", { checkOut: new Date("2026-09-24T15:00:00Z") }, "CHECKOUT_REQUIRED"],
  ["invalid checkout", { checkOut: new Date(NaN) }, "CHECKOUT_REQUIRED"],
  ["invalid clock", { now: new Date(NaN) }, "CHECKOUT_REQUIRED"],
  ["not direct", { directBooking: false }, "PROTECTION_NOT_ELIGIBLE"],
  ["disabled", { protectionEnabled: false }, "PROTECTION_NOT_ELIGIBLE"],
  ["wrong mode", { protectionMode: "DEPOSIT" }, "PROTECTION_NOT_ELIGIBLE"],
  ["missing account", { connectedAccountId: "" }, "SCOPE_REQUIRED"],
  ["missing revision", { claimRevision: " " }, "SCOPE_REQUIRED"],
  ["closed timestamp", { closedAt: new Date() }, "CASE_NOT_OPEN_FOR_PAYMENT"],
  ...["OPEN", "HOST_REVIEW", "GUEST_NOTIFICATION_PENDING", "CLOSED_NO_CHARGE", "CHARGE_BLOCKED", "UNKNOWN"].map(status =>
    [status, { status }, "CASE_NOT_OPEN_FOR_PAYMENT"] as [string, Partial<DamageChargeEligibilityInput>, string]),
  ...["PENDING", "ACKNOWLEDGED", "DISPUTED", "UNKNOWN"].map(guestResponse =>
    [guestResponse, { guestResponse }, "GUEST_ACCEPTANCE_REQUIRED"] as [string, Partial<DamageChargeEligibilityInput>, string]),
  ["no approver", { hostApprovedByUserId: null }, "HOST_APPROVAL_REQUIRED"],
  ["no approval", { hostApprovedAt: null }, "HOST_APPROVAL_REQUIRED"],
  ["approval before checkout", { hostApprovedAt: new Date("2026-09-23T14:00:00Z") }, "HOST_APPROVAL_REQUIRED"],
  ["future approval", { hostApprovedAt: new Date("2026-09-24") }, "HOST_APPROVAL_REQUIRED"],
  ["no notification", { guestNotifiedAt: null }, "GUEST_NOTIFICATION_REQUIRED"],
  ["early notification", { guestNotifiedAt: fixture().checkOut }, "GUEST_NOTIFICATION_REQUIRED"],
  ["future notification", { guestNotifiedAt: new Date("2026-09-24") }, "GUEST_NOTIFICATION_REQUIRED"],
  ["over cap", { acceptedMaximumMinor: 10000 }, "LIABILITY_LIMIT_EXCEEDED"],
  ["different cap currency", { maximumCurrency: "eur" }, "CURRENCY_NOT_SUPPORTED"],
  ["unsupported currency", { currency: "eur", maximumCurrency: "eur" }, "CURRENCY_NOT_SUPPORTED"],
  ["legacy accepted response alone", { authorization: null }, "PAYMENT_AUTHORIZATION_REQUIRED"],
];
for (const [name, patch, reason] of blockedCases) test(name, () => {
  assert.deepEqual(evaluate({ ...fixture(), ...patch }), { eligible: false, reason });
});

for (const field of ["approvedAmountMinor", "acceptedMaximumMinor"] as const) {
  for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    test(`${field} rejects ${value}`, () => {
      assert.equal(evaluate({ ...fixture(), [field]: value }).reason, "INVALID_AMOUNT");
    });
  }
}
test("exact liability limit is allowed", () => {
  assert.equal(evaluate({ ...fixture(), acceptedMaximumMinor: 10001 }).eligible, true);
});
for (const field of ["organizationId", "reservationId", "damageCaseId", "connectedAccountId", "claimRevision", "currency", "amountMinor", "version", "action", "authorizedAt"] as const) {
  test(`authorization mismatch: ${field}`, () => {
    const input = fixture();
    const value = field === "authorizedAt" ? new Date(NaN) : field === "amountMinor" ? 10002 : "different";
    input.authorization = { ...input.authorization!, [field]: value };
    assert.equal(evaluate(input).eligible, false);
  });
}
test("old non-financial response version never authorizes payment", () => {
  const input = fixture();
  input.authorization!.version = "PROPERTY_PROTECTION_GUEST_RESPONSE_V1";
  assert.equal(evaluate(input).reason, "PAYMENT_AUTHORIZATION_REQUIRED");
});
for (const date of ["2026-09-23T16:00:00Z", "2026-09-24T00:00:00Z"]) {
  test(`authorization out of sequence: ${date}`, () => {
    const input = fixture();
    input.authorization!.authorizedAt = new Date(date);
    assert.equal(evaluate(input).reason, "AUTHORIZATION_TIME_INVALID");
  });
}
