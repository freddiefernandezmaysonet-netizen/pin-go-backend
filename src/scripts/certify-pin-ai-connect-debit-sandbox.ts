import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import Stripe from "stripe";

const PLATFORM = "acct_1SmdRdRzkK1jKKf3";
const CONNECT = "acct_1UMuCTRzkKtvlWsd";
const RESERVATION = "qa-pin-ai-connect-20261006-v1";
const KEY = `pin-ai-connect-qa-v1:${RESERVATION}`;
const usd = (balance: Stripe.Balance) => balance.available.filter(v => v.currency === "usd")
  .reduce((sum, v) => sum + v.amount, 0);

// Standalone authorized sandbox certification, not the production collection
// worker. Exact account IDs prevent using another host or a production account.
export async function certifyPinAIConnectDebit(stripe: Stripe) {
  assert.equal((await stripe.accounts.retrieve()).id, PLATFORM);
  const account = await stripe.accounts.retrieve(CONNECT);
  assert.equal(account.country, "US"); assert.equal(account.default_currency, "usd");
  assert.equal(account.controller?.losses?.payments, "application");
  const balance = () => stripe.balance.retrieve({}, { stripeAccount: CONNECT });
  const initial = await balance(); assert.equal(initial.livemode, false);
  const initialAvailable = usd(initial);
  console.log(JSON.stringify({ stage: "CONNECT_BALANCE", account: CONNECT, livemode: false,
    availableCents: initialAvailable, pending: initial.pending.map(v => ({ currency: v.currency, amount: v.amount })) }));
  let fundingId: string | null = null;
  if (initialAvailable < 100) {
    // Only funding the test balance, never the commercial Pin AI collection.
    const funding = await stripe.charges.create({ amount: 500, currency: "usd", source: "tok_bypassPending",
      description: "Synthetic balance funding for Pin AI Connect QA",
      metadata: { pin_ai_qa: RESERVATION, synthetic: "true", purpose: "test_balance_funding" } },
    { stripeAccount: CONNECT, idempotencyKey: `${KEY}:funding` });
    assert.equal(funding.livemode, false); assert.equal(funding.paid, true); fundingId = funding.id;
  }
  const before = await balance(); assert.equal(before.livemode, false);
  assert.ok(usd(before) >= 100, "No available test funds; no debit attempted");
  const params = { amount: 100, currency: "usd", source: CONNECT,
    description: "Pin AI Connect QA: USD 1.00 per synthetic reservation",
    metadata: { pinAIReservationId: RESERVATION, synthetic: "true", purpose: "pin_ai_reservation_fee" } };
  const payment = await stripe.charges.create(params, { idempotencyKey: KEY });
  // API 2023-10-16 returns a py_ Payment with object "charge".
  assert.ok(["charge", "payment"].includes((payment as unknown as { object: string }).object));
  assert.ok(payment.id.startsWith("py_"), "Expected an Account Debit Payment");
  assert.equal(typeof payment.source === "string" ? payment.source : payment.source?.id, CONNECT);
  assert.equal(payment.livemode, false); assert.equal(payment.amount, 100);
  assert.equal(payment.currency, "usd"); assert.equal(payment.paid, true);
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.metadata.pinAIReservationId, RESERVATION);
  const after = await balance();
  const replay = await stripe.charges.create(params, { idempotencyKey: KEY });
  assert.equal(replay.id, payment.id, "Retry created another Payment");
  const afterReplay = await balance();
  assert.equal(usd(before) - usd(after), 100, "Connected balance did not decrease by exactly USD 1");
  assert.equal(usd(afterReplay), usd(after), "Retry changed the connected balance");
  return { platform: PLATFORM, connectedAccount: CONNECT, reservationId: RESERVATION,
    apiVersion: "2023-10-16", sdk: "14.25.0", livemode: false, fundingId,
    initialAvailableCents: initialAvailable, beforeDebitCents: usd(before), afterDebitCents: usd(after),
    afterReplayCents: usd(afterReplay), paymentId: payment.id, amountCents: 100, currency: "usd",
    samePaymentOnRetry: true, certified: true, productionLedgerCertified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // This fixed QA key must never be reused after Stripe idempotency retention.
    assert.ok(Date.now() < Date.parse("2026-10-06T19:46:00Z"), "QA_RUN_EXPIRED");
    const key = process.env.PIN_AI_SANDBOX_STRIPE_SECRET_KEY?.trim();
    if (!key || !/^(sk|rk)_test_\S+$/.test(key)) throw new Error("TEST_KEY_REQUIRED");
    const stripe = new Stripe(key, { apiVersion: "2023-10-16", timeout: 30_000, maxNetworkRetries: 0 });
    console.log(JSON.stringify(await certifyPinAIConnectDebit(stripe)));
  } catch (error) {
    const e = error as { code?: string; type?: string; param?: string };
    const safe = (v?: string) => v && /^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(v) ? v : null;
    console.error(JSON.stringify({ certified: false, reservationId: RESERVATION,
      code: safe(e?.code), type: safe(e?.type), param: safe(e?.param) }));
    process.exitCode = 1;
  }
}
