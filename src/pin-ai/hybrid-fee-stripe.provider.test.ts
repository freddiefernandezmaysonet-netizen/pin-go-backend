import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createHybridFeeStripeProvider } from "./hybrid-fee-stripe.provider.js";
import { PIN_AI_HYBRID_BILLING_TERMS as TERMS } from "./billing-terms.js";
const fee = { reservationId: "r", organizationId: "org", propertyId: "p", amountCents: 100, currency: "USD",
  termsVersion: TERMS.version, stripeConnectedAccountId: "acct_host", stripePaymentIntentId: "pi_guest",
  stripeApplicationFeeId: "fee_platform", stripeCustomerId: "cus_host", stripeSubscriptionId: "sub_membership",
  stripeInvoiceItemId: "ii_pin_ai", collectionMethod: "MEMBERSHIP" } as any;
const metadata = { pinAIReservationId: "r", organizationId: "org", propertyId: "p", pinAITermsVersion: TERMS.version };
test("actual public checkout metadata fits Stripe's limit with hybrid consent and preserves the cancellation snapshot", () => {
  const source = ts.createSourceFile("checkout.ts", readFileSync("src/routes/public-booking.routes.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "stripe.checkout.sessions.create") {
      const argument = node.arguments[0];
      assert.ok(ts.isObjectLiteralExpression(argument));
      const property = argument.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === "metadata");
      assert.ok(property && ts.isPropertyAssignment(property));
      expression = property.initializer.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(expression);
  const policy = { name: "Synthetic", type: "CUSTOM", refundBasis: "TOTAL_AMOUNT", policyId: "policy",
    freeCancellationHoursBeforeCheckIn: 24, refundPercentBeforeDeadline: 100, refundPercentAfterDeadline: 0 };
  for (const enabled of [false, true]) {
    const consent = enabled ? { pinAIFeeAmountCents: "100", pinAITermsVersion: TERMS.version,
      pinAITermsAcceptedBy: "host", pinAITermsAcceptedAt: "2030-01-01T00:00:00Z" } : {};
    const values = runInNewContext(`(${expression})`, {
      pinAIFeeMetadata: consent, pinAIFeeAmountCents: enabled ? 100 : 0,
      normalizedPreferredLanguage: "es", property: { id: "p", organizationId: "org" },
      stayDates: { checkIn: new Date("2030-01-02"), checkOut: new Date("2030-01-03"), timeZone: "UTC", checkInTime: "16:00", checkOutTime: "11:00" },
      guestName: "Synthetic", guestEmail: "synthetic@example.com", guestPhone: "", stayNotificationsConsent: false,
      propertyProtectionCheckoutEvidence: "{}", guestAcceptedSecurePreCheckinRequirementAt: "2030-01-01",
      guestAcceptedSecurePreCheckinRequirementText: "accepted", toStripeMetadataValue: String,
      SECURE_PRECHECKIN_DISCLOSURE_VERSION: "v1", SECURE_PRECHECKIN_DISCLOSURE_SOURCE: "DIRECT_BOOKING_WEB_FORM",
      adultsCount: 1, childrenCount: 0, nights: 1, pricing: { nightlyRate: 100, cleaningFee: 0, amenitiesTotal: 0, taxesTotal: 0, totalAmount: 100 },
      cleanSelectedAmenityIds: [], connectedAccountId: "acct_host", basePlatformFeeAmount: 5,
      directBookingProtectionFeeAmount: 0, identityVerificationRequired: false, platformFeeAmount: enabled ? 6 : 5,
      hostPayoutAmount: enabled ? 94 : 95, guestAcceptedCancellationTermsAt: "2030-01-01",
      guestAcceptedCancellationTermsText: "accepted", cancellationPolicySnapshot: policy,
      cancellationPolicyMetadata: JSON.stringify(policy),
    }) as Record<string, string>;
    // The billing wrapper removes this derived key and adds charge mode.
    delete values.hostPayoutStatus; values.stripeChargeMode = "DIRECT_CHARGE";
    assert.equal(Object.keys(values).length, 50);
    assert.deepEqual(JSON.parse(values.cancellationPolicySnapshot), policy);
    assert.equal(values.guestAcceptedCancellationTerms, "true");
    assert.equal(values.securePrecheckinAccepted, "true");
    assert.equal(values.pinAIFeeAmountCents, enabled ? "100" : undefined);
    if (enabled) assert.equal(values.pinAITermsAcceptedBy, "host");
  }
});
function fixture({ guestRefunded = 0, feeRefunded = 0, invoiceStatus = "paid", amountRemaining = 0,
  itemInvoice = "in_membership", customerId = "cus_host" } = {}) {
  const calls: any[] = [];
  const stripe = {
    subscriptions: { retrieve: async () => ({ customer: "cus_host", metadata: { organizationId: "org" }, status: "active", currency: "usd" }) },
    paymentIntents: { retrieve: async (...args: any[]) => { calls.push(["pi", ...args]); return {
      status: "succeeded", application_fee_amount: 600, metadata: { pinAIFeeAmountCents: "100", pinAITermsVersion: TERMS.version, propertyId: "p", organizationId: "org" }, latest_charge: { id: "ch_guest", paid: true,
        application_fee: "fee_platform", amount: 10000, amount_refunded: guestRefunded } }; } },
    applicationFees: { retrieve: async () => ({ id: "fee_platform", account: "acct_host", charge: "ch_guest",
      amount: 600, amount_refunded: feeRefunded, currency: "usd" }),
      createRefund: async (...args: any[]) => { calls.push(["fee-refund", ...args]); return { id: "fr_1" }; },
      listRefunds: async function* () { yield { id: "fr_1", metadata: { pinAIOperationKey: "key" } }; } },
    invoiceItems: { create: async (...args: any[]) => { calls.push(["item", ...args]); return { id: "ii_pin_ai" }; },
      retrieve: async () => ({ id: "ii_pin_ai", customer: customerId, subscription: "sub_membership", amount: 100,
        currency: "usd", metadata, invoice: itemInvoice || null }),
      del: async (...args: any[]) => { calls.push(["delete", ...args]); return { deleted: true }; } },
    invoices: { retrieve: async () => ({ customer: "cus_host", subscription: "sub_membership", status: invoiceStatus,
      amount_remaining: amountRemaining }), listLineItems: async function* () { yield { id: "il_fee", invoice_item: "ii_pin_ai" }; } },
    creditNotes: { preview: async () => ({ amount: 100 }), create: async (...args: any[]) => {
      calls.push(["credit", ...args]); return { id: "cn_1" }; } },
  };
  return { provider: createHybridFeeStripeProvider(stripe as any), calls };
}
for (const [guestRefunded, target] of [[0, 100], [5000, 350], [10000, 600]]) {
  test(`cancellation returns Pin AI fully and other commission proportionally: guest refund ${guestRefunded}`, async () => {
    const h = fixture({ guestRefunded });
    const request = await h.provider.reversalPlan({ ...fee, collectionMethod: "DIRECT_APPLICATION_FEE" });
    assert.deepEqual(request, { kind: "APPLICATION_FEE_REFUND", feeId: "fee_platform", amount: target, target });
    assert.equal(h.calls[0][3].stripeAccount, "acct_host");
    await h.provider.reverse(fee, request, "key");
    const call = h.calls.find(c => c[0] === "fee-refund");
    assert.equal(call[2].amount, target); assert.equal(call[3].idempotencyKey, "key");
    assert.equal(call[3].stripeAccount, undefined, "application fee refund belongs to the platform");
  });
}
test("already returned Pin AI is not returned twice; later guest refund returns only commission difference", async () => {
  assert.deepEqual(await fixture({ feeRefunded: 100 }).provider.reversalPlan({ ...fee, collectionMethod: "DIRECT_APPLICATION_FEE" }), { kind: "NONE" });
  assert.deepEqual(await fixture({ feeRefunded: 100, guestRefunded: 5000 }).provider.reversalPlan({ ...fee, collectionMethod: "DIRECT_APPLICATION_FEE" }),
    { kind: "APPLICATION_FEE_REFUND", feeId: "fee_platform", amount: 250, target: 350 });
});
test("OTA item is bound to the membership customer/subscription, nondiscountable and contains no Connect debit", async () => {
  const h = fixture(); await h.provider.createItem(fee, "key");
  const call = h.calls[0]; assert.equal(call[1].amount, 100); assert.equal(call[1].customer, "cus_host");
  assert.equal(call[1].subscription, "sub_membership"); assert.equal(call[1].discountable, false);
  assert.deepEqual(call[1].tax_rates, []); assert.equal(call[2].idempotencyKey, "key");
  assert.equal(call[2].stripeAccount, undefined);
  assert.equal(await h.provider.validateMembership("cus_other", "sub_membership", "org"), false);
});
for (const invoiceStatus of ["pending", "draft"]) test(`cancelled ${invoiceStatus} item is deleted`, async () => {
  const h = fixture({ invoiceStatus, itemInvoice: invoiceStatus === "pending" ? "" : "in_membership" });
  assert.deepEqual(await h.provider.reversalPlan(fee), { kind: "DELETE_ITEM", itemId: "ii_pin_ai" });
});
for (const [invoiceStatus, amountRemaining, creditAmount] of [["paid", 0, 100], ["open", 2000, 0], ["open", 30, 70]] as const)
  test(`cancelled ${invoiceStatus} invoice uses an exact line credit and ${creditAmount} balance credit`, async () => {
    const h = fixture({ invoiceStatus, amountRemaining }); const request = await h.provider.reversalPlan(fee);
    assert.deepEqual(request, { kind: "CREDIT_NOTE", invoiceId: "in_membership", lineId: "il_fee", creditAmount });
    await h.provider.reverse(fee, request, "key"); const call = h.calls[0];
    assert.equal(call[1].credit_amount, creditAmount > 0 ? creditAmount : undefined); assert.equal(call[1].lines[0].amount, 100);
    assert.equal(call[1].lines[0].invoice_line_item, "il_fee");
  });
test("wrong host invoice cannot be billed, marked paid, deleted, or credited", async () => {
  const h = fixture({ customerId: "cus_other" });
  await assert.rejects(h.provider.reversalPlan(fee), /SCOPE_MISMATCH/);
  await assert.rejects(h.provider.itemState(fee), /SCOPE_MISMATCH/);
  assert.equal(h.calls.length, 0);
});
