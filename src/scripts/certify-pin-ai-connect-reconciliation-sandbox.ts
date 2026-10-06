import assert from "node:assert/strict";
import type Stripe from "stripe";
import type { PinAIReservationFee } from "@prisma/client";
import { createPinAIConnectStripeProvider } from "../pin-ai/fee-connect-stripe.provider.js";

const PLATFORM = "acct_1SmdRdRzkK1jKKf3";
const ACCOUNT = "acct_1UMuCTRzkKtvlWsd";
const PAYMENT = "py_1UNdO4RzkK1jKKf3MupiM9op";
const RESERVATION = "qa-pin-ai-connect-20261006-v1";

// Read-only certificate of the actual lookup adapter, not a new payment or a
// production ledger certificate. Prior QA payment lacks commercial metadata.
export async function certifyPinAIConnectReconciliation(stripe: Stripe, now = new Date()) {
  assert.equal((await stripe.accounts.retrieve()).id, PLATFORM);
  const original = await stripe.charges.retrieve(PAYMENT);
  assert.equal(original.livemode, false); assert.equal(original.amount, 100);
  assert.equal(original.currency, "usd"); assert.equal(original.paid, true);
  assert.equal(original.metadata.pinAIReservationId, RESERVATION);
  const balance = () => stripe.balance.retrieve({}, { stripeAccount: ACCOUNT });
  const before = await balance(); assert.equal(before.livemode, false);
  // No create-capable method is passed to the provider. An accidental write
  // fails locally rather than reaching Stripe.
  const readsOnly = { balanceTransactions: { list: stripe.balanceTransactions.list.bind(stripe.balanceTransactions) },
    charges: { retrieve: stripe.charges.retrieve.bind(stripe.charges) } } as unknown as Stripe;
  const provider = createPinAIConnectStripeProvider(readsOnly);
  const evidence = await provider.reconcile!({ reservationId: RESERVATION,
    debitStartedAt: new Date(original.created * 1000) } as PinAIReservationFee, now);
  assert.equal(evidence.complete, true); assert.equal(evidence.payments.length, 1);
  const found = evidence.payments[0];
  assert.equal(found.id, PAYMENT); assert.equal(found.accountId, ACCOUNT);
  assert.equal(found.amount, 100); assert.equal(found.currency, "usd");
  assert.equal(found.paid, true); assert.equal(found.status, "succeeded");
  const after = await balance(); assert.deepEqual(after.available, before.available);
  return { certified: true, certificate: "CONNECT_RECONCILIATION_READ_ONLY", livemode: false,
    paymentId: found.id, accountId: found.accountId, amountCents: found.amount,
    complete: evidence.complete, balanceUnchanged: true, productionLedgerCertified: false };
}
