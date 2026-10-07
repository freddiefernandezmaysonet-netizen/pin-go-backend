import assert from "node:assert/strict";
import test from "node:test";
import { getIdentityCheckFeeCents, identityCheckBillingTerms, resolveIdentityBillingConsent, validIdentityBillingConsent } from "./identity-check-billing-consent.js";
const terms = identityCheckBillingTerms({});
const now = new Date("2026-10-06T23:00:00Z");
const input = { existing: null, requiresIdentityVerification: true, acceptedTermsVersion: undefined,
  terms, actorId: "host-a", now };
test("uses current Direct Booking tariff and rejects invalid rates", () => {
  assert.equal(terms.amountCents, 250);
  assert.equal(getIdentityCheckFeeCents({ DIRECT_BOOKING_PROTECTION_FEE_AMOUNT: "3.75" }), 375);
  for (const value of ["bad", "-1", "Infinity"]) assert.throws(() => getIdentityCheckFeeCents({ DIRECT_BOOKING_PROTECTION_FEE_AMOUNT: value }), /INVALID/);
});
test("enabling cannot infer authorization from a legacy agreement or mismatched terms", () => {
  assert.throws(() => resolveIdentityBillingConsent(input), /TERMS_REQUIRED/);
  assert.throws(() => resolveIdentityBillingConsent({ ...input, acceptedTermsVersion: "old" }), /TERMS_REQUIRED/);
});
test("acceptance records actor, time and exact rate once; valid acceptance is retained", () => {
  const accepted = resolveIdentityBillingConsent({ ...input, acceptedTermsVersion: terms.version });
  assert.equal(accepted.identityBillingAcceptedBy, "host-a");
  assert.equal(accepted.identityBillingAcceptedAt, now);
  assert.equal(validIdentityBillingConsent(accepted, terms), true);
  const reused = resolveIdentityBillingConsent({ ...input, existing: { ...accepted, id: "old-agreement" } as typeof accepted,
    actorId: "host-b", now: new Date(now.getTime() + 1000) });
  assert.deepEqual(reused, accepted);
  assert.equal("id" in reused, false);
});
test("disabling needs no acceptance and retains historical evidence", () => {
  const none = resolveIdentityBillingConsent({ ...input, requiresIdentityVerification: false });
  assert.equal(none.identityBillingAcceptedAt, null);
  const accepted = resolveIdentityBillingConsent({ ...input, acceptedTermsVersion: terms.version });
  assert.deepEqual(resolveIdentityBillingConsent({ ...input, existing: accepted, requiresIdentityVerification: false }), accepted);
});
test("a rate change requires renewed acceptance and preserves the prior record", () => {
  const accepted = resolveIdentityBillingConsent({ ...input, acceptedTermsVersion: terms.version });
  const changedTerms = identityCheckBillingTerms({ DIRECT_BOOKING_PROTECTION_FEE_AMOUNT: "3.00" });
  assert.equal(validIdentityBillingConsent(accepted, changedTerms), false);
  assert.throws(() => resolveIdentityBillingConsent({ ...input, existing: accepted, terms: changedTerms }), /TERMS_REQUIRED/);
  assert.equal(accepted.identityBillingAmountCents, 250);
});
