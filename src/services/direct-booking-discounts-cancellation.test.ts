import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCancellationPolicy, type CancellationPolicySnapshot } from "./cancellation-policy.service";
const snapshot: CancellationPolicySnapshot = {
  policyId: null, name: "Test", type: "CUSTOM", source: "TEST", guestSelfCancellationEnabled: true,
  autoRefundEligibleCancellations: true, requireHostApprovalOutsidePolicy: false,
  freeCancellationHoursBeforeCheckIn: 24, refundBasis: "NIGHTLY_SUBTOTAL", refundPercentBeforeDeadline: 50,
  refundPercentAfterDeadline: 0, refundRules: [], nonRefundableScenarios: [], guestFacingSummary: null,
  cleaningFeeRefundable: false, amenitiesRefundable: false, taxesRefundable: false,
  nonRefundableDiscountPercent: null, description: null, snapshotAt: "2026-11-11T12:00:00Z",
};
test("nightly-only cancellation refunds discounted accommodation, not original subtotal", () => {
  const result = evaluateCancellationPolicy({ snapshot, checkIn: new Date("2027-01-01"), requestedAt: new Date("2026-12-01"),
    totalAmount: 1000, pricingBreakdown: { nightlySubtotal: 1000, accommodationSubtotalAfterDiscount: 900, cleaningFee: 75, amenitiesTotal: 25, taxesTotal: 0 } });
  assert.equal(result.refundAmountCents, 45000);
});
test("legacy reservations retain original cancellation calculation", () => {
  const result = evaluateCancellationPolicy({ snapshot, checkIn: new Date("2027-01-01"), requestedAt: new Date("2026-12-01"),
    totalAmount: 1100, pricingBreakdown: { nightlySubtotal: 1000, cleaningFee: 75, amenitiesTotal: 25, taxesTotal: 0 } });
  assert.equal(result.refundAmountCents, 50000);
});
