import assert from "node:assert/strict";
import test from "node:test";
import type { PinAIReservationFee, PrismaClient } from "@prisma/client";
import { collectPinAIConnectFee, ConnectDebitInsufficientBalanceError, pinAIConnectBillingAllows,
  type ConnectDebitProvider } from "./fee-connect.service.js";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";
import { runPinAIConnectBillingCycle } from "./fee-connect-cycle.service.js";
const now = new Date("2026-10-06T19:00:00Z");
const env = { PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: "org" };
function fixture() {
  const row = { reservationId: "r", organizationId: "org", propertyId: "p", amountCents: 100, currency: "USD",
    termsVersion: PIN_AI_BILLING_TERMS.version, acceptedBy: "host", acceptedAt: now, serviceStartedAt: now,
    billingStatus: "PENDING_CONNECT", stripeConnectedAccountId: "acct_host", stripeDebitPaymentId: null,
    stripeInvoiceItemId: null, stripeInvoiceId: null, debitStartedAt: null, debitGeneration: 0,
    exportAttempts: 0, exportLeaseToken: null, exportLeaseUntil: null, exportNextAttemptAt: null } as PinAIReservationFee;
  let accountId = "acct_host", available = 100, calls = 0, balanceReads = 0;
  let loseResponse = false, failPaidSave = false, balanceRace = false;
  const requests = new Map<string, any>();
  const db = { property: { findFirst: async () => ({ pinAIFeeExempt: false }) }, organization: { findUnique: async () => ({ stripeConnectAccountId: accountId }) },
    pinAIReservationFee: { findUnique: async () => ({ ...row }), findUniqueOrThrow: async () => ({ ...row }),
      updateMany: async ({ where, data }: any) => {
        if (where.exportLeaseToken && where.exportLeaseToken !== row.exportLeaseToken) return { count: 0 };
        if (where.exportAttempts !== undefined && where.exportAttempts !== row.exportAttempts) return { count: 0 };
        if (data.billingStatus === "PAID" && failPaidSave) { failPaidSave = false; throw Error("db interrupted"); }
        for (const [key, value] of Object.entries(data)) (row as any)[key] =
          value && typeof value === "object" && "increment" in value ? (row as any)[key] + (value as any).increment : value;
        return { count: 1 };
      } } } as unknown as PrismaClient;
  const provider: ConnectDebitProvider = {
    eligibility: async () => { balanceReads++; return { compatible: true, availableCents: available }; },
    create: async (fee, key) => {
      calls++;
      if (balanceRace) { balanceRace = false; throw new ConnectDebitInsufficientBalanceError(); }
      if (!requests.has(key)) {
        available -= 100;
        requests.set(key, { id: "py_one", accountId: fee.stripeConnectedAccountId, amount: 100, currency: "usd",
          paid: true, status: "succeeded", metadata: { pinAIReservationId: "r", organizationId: "org",
            propertyId: "p", pinAITermsVersion: fee.termsVersion } });
      }
      if (loseResponse) { loseResponse = false; throw Error("response lost"); }
      return requests.get(key);
    },
    retrieve: async () => [...requests.values()][0],
  };
  return { row, db, provider, setAvailable: (v: number) => { available = v; },
    changeAccount: () => { accountId = "acct_other"; }, loseResponse: () => { loseResponse = true; },
    failPaidSave: () => { failPaidSave = true; }, balanceRace: () => { balanceRace = true; },
    counts: () => ({ available, calls, balanceReads, requests: requests.size }) };
}
test("new Connect gate rejects old invoice switches and wildcard", () => {
  assert.equal(pinAIConnectBillingAllows({ PIN_AI_BILLING_ENABLED: "true", PIN_AI_BILLING_ORGANIZATION_IDS: "org" }, "org"), false);
  assert.equal(pinAIConnectBillingAllows({ ...env, PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: "*" }, "org"), false);
});
test("global scope admits current and future organizations only with debit enabled", () => {
  const global = { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ENABLED: "true" };
  for (const id of ["current-org", "future-org"]) assert.equal(pinAIConnectBillingAllows(global, id), true);
  assert.equal(pinAIConnectBillingAllows(global, ""), false);
  assert.equal(pinAIConnectBillingAllows({ ...global, PIN_AI_CONNECT_DEBIT_ENABLED: "false" }, "current-org"), false);
  assert.equal(pinAIConnectBillingAllows({ ...global, PIN_AI_ALL_ORGANIZATIONS_ENABLED: "false" }, "current-org"), false);
});
test("global worker queries all organizations while retaining consent, Demo exclusion and bounded batches", async () => {
  const queries: { model: string; args: any }[] = [];
  const model = (name: string) => ({ findMany: async (args: any) => { queries.push({ model: name, args }); return []; } });
  const db = { reservation: model("reservation"), pinAIServiceEnrollment: model("enrollment"),
    pinAIReservationFee: model("fee") } as unknown as PrismaClient;
  const provider = {} as ConnectDebitProvider;
  await runPinAIConnectBillingCycle(db, provider, { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true",
    PIN_AI_CONNECT_DEBIT_ENABLED: "false" }, now);
  assert.equal(queries.length, 0);
  await runPinAIConnectBillingCycle(db, provider, { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true",
    PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true",
    PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true" }, now);
  assert.equal(queries.length, 4);
  for (const q of queries) {
    assert.equal(q.args.where.organizationId, undefined);
    assert.ok(q.args.take <= 20);
    if (q.model === "reservation") {
      const p = q.args.where.property;
      assert.equal(p.organizationId, undefined); assert.equal(p.pinAIEnabled, true);
      assert.equal(p.isTestProperty, false); assert.equal(p.pinAITermsVersion, PIN_AI_BILLING_TERMS.version);
      assert.deepEqual(p.pinAITermsAcceptedBy, { not: null });
      assert.equal(q.args.where.AND.length, 2);
    }
  }
});
test("one fee pays once; a paid repeat makes no provider call", async () => {
  const h = fixture();
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "PAID");
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "PAID");
  assert.deepEqual(h.counts(), { available: 0, calls: 1, balanceReads: 1, requests: 1 });
});
test("insufficient available balance stays pending; later funds collect the original reservation", async () => {
  const h = fixture(); h.setAvailable(0);
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "PENDING_BALANCE");
  assert.equal(h.row.debitStartedAt, null); assert.equal(h.counts().calls, 0);
  h.setAvailable(100);
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", new Date(+now + 3600000)), "PAID");
});
for (const failure of ["loseResponse", "failPaidSave"] as const) {
  test(`uncertain ${failure} replays the same debit even when balance is now zero`, async () => {
    const h = fixture(); h[failure]();
    assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "RETRY_PENDING");
    assert.equal(h.counts().available, 0); assert.ok(h.row.debitStartedAt);
    assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", new Date(+now + 60000)), "PAID");
    assert.equal(h.counts().requests, 1); assert.equal(h.counts().balanceReads, 1);
  });
}
test("definitive balance race retires rejected key and waits for later funding", async () => {
  const h = fixture(); h.balanceRace();
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "PENDING_BALANCE");
  assert.equal(h.row.debitGeneration, 1); assert.equal(h.row.debitStartedAt, null);
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", new Date(+now + 3600000)), "PAID");
  assert.equal(h.counts().requests, 1);
});
test("expired uncertain request cannot create another debit", async () => {
  const h = fixture(); h.row.debitStartedAt = new Date(+now - 23 * 3600000);
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "NEEDS_REVIEW");
  assert.equal(h.counts().calls, 0);
});
test("changed host account cannot redirect the accrued fee", async () => {
  const h = fixture(); h.changeAccount();
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "NEEDS_REVIEW");
  assert.equal(h.counts().calls, 0);
});
test("old SaaS acceptance never permits a Connect charge", async () => {
  const h = fixture(); h.row.termsVersion = "pin-ai-usd-1-reservation-v1";
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "NEEDS_REVIEW");
  assert.equal(h.counts().calls, 0);
});
test("wrong provider tenant evidence is not marked paid", async () => {
  const h = fixture(); const create = h.provider.create;
  h.provider.create = async (f, k) => ({ ...await create(f, k), accountId: "acct_other" });
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "NEEDS_REVIEW");
  assert.equal(h.row.paidAt, undefined);
});
test("simultaneous claim allows one provider request", async () => {
  const h = fixture();
  const results = await Promise.all([collectPinAIConnectFee(h.db, h.provider, env, "r", now),
    collectPinAIConnectFee(h.db, h.provider, env, "r", now)]);
  assert.deepEqual(results.sort(), ["BUSY", "PAID"]);
  assert.equal(h.counts().calls, 1);
});

test("interrupted worker lease blocks another attempt until expiry, then replays original request", async () => {
  const h = fixture(); h.loseResponse();
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "RETRY_PENDING");
  h.row.exportNextAttemptAt = null;
  h.row.exportLeaseToken = "interrupted-worker";
  h.row.exportLeaseUntil = new Date(+now + 90000);
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", new Date(+now + 60000)), "BUSY");
  assert.equal(h.counts().calls, 1);
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", new Date(+now + 90000)), "PAID");
  assert.equal(h.counts().requests, 1);
  assert.equal(h.counts().available, 0);
});

test("future service start never permits an early debit", async () => {
  const h = fixture(); h.row.serviceStartedAt = new Date(+now + 1);
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "NOT_DUE");
  assert.equal(h.counts().calls, 0);
});

for (const alreadyReviewed of [false, true]) {
  test(`expired uncertain debit reconciles original payment read-only; previously reviewed=${alreadyReviewed}`, async () => {
    const h = fixture(); h.loseResponse();
    assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", now), "RETRY_PENDING");
    if (alreadyReviewed) { h.row.billingStatus = "NEEDS_REVIEW"; h.row.lastError = "CONNECT_REPLAY_WINDOW_EXPIRED"; }
    h.provider.reconcile = async () => ({ complete: true, payments: [await h.provider.retrieve("py_one")] });
    assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", new Date(+now + 48 * 3600000)), "PAID");
    assert.equal(h.row.stripeDebitPaymentId, "py_one");
    assert.equal(h.counts().calls, 1); assert.equal(h.counts().available, 0);
  });
}
for (const mode of ["empty", "truncated", "multiple", "wrong-account"] as const) {
  test(`expired evidence ${mode} never permits another debit`, async () => {
    const h = fixture(); h.loseResponse();
    await collectPinAIConnectFee(h.db, h.provider, env, "r", now);
    const original = await h.provider.retrieve("py_one");
    h.provider.reconcile = async () => ({ complete: mode !== "truncated", payments: mode === "empty" ? [] :
      mode === "multiple" ? [original, { ...original, id: "py_two" }] :
      mode === "wrong-account" ? [{ ...original, accountId: "acct_other" }] : [original] });
    assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", new Date(+now + 48 * 3600000)), "NEEDS_REVIEW");
    assert.equal(h.counts().calls, 1); assert.equal(h.row.stripeDebitPaymentId, null);
  });
}
test("failed expired evidence scan remains retryable without creating, then reconciles", async () => {
  const h = fixture(); h.loseResponse();
  await collectPinAIConnectFee(h.db, h.provider, env, "r", now);
  h.row.billingStatus = "NEEDS_REVIEW"; h.row.lastError = "CONNECT_REPLAY_WINDOW_EXPIRED";
  h.provider.reconcile = async () => { throw Error("read timeout"); };
  const later = new Date(+now + 48 * 3600000);
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", later), "RETRY_PENDING");
  assert.equal(h.row.billingStatus, "PENDING_CONNECT");
  assert.equal(h.counts().calls, 1);
  h.provider.reconcile = async () => ({ complete: true, payments: [await h.provider.retrieve("py_one")] });
  assert.equal(await collectPinAIConnectFee(h.db, h.provider, env, "r", new Date(+later + 60000)), "PAID");
  assert.equal(h.counts().calls, 1);
});
