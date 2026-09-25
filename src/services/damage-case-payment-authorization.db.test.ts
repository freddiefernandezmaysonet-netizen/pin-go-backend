import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import { damagePaymentAuthorizationRouter } from "../routes/public-booking.damage-payment-authorization.routes.js";
import { getDamagePaymentAuthorizationTerms as getTerms, recordDamagePaymentAuthorization as record,
  DamagePaymentAuthorizationError } from "./damage-case-payment-authorization.service.js";
import { executeDamageCasePayment } from "./damage-case-payment-execution.service.js";
import { reconcileDamageCasePaymentIntent } from "./damage-case-payment-webhook.service.js";
import type Stripe from "stripe";

const TEST_URL = "postgresql://postgres:postgres@127.0.0.1:5432/pingo_damage_authorization_test";
test("exact damage payment authorization in disposable PostgreSQL", async t => {
  assert.equal(process.env.DAMAGE_AUTHORIZATION_TEST_DATABASE_URL, TEST_URL, "Refusing non-disposable database");
  const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  t.after(() => db.$disconnect());
  for (const count of await Promise.all([db.organization.count(), db.reservation.count(), db.damageCasePaymentAuthorization.count()]))
    assert.equal(count, 0, "Never reset existing records; start with an empty CI database");
  let sequence = 0;
  async function fixture() {
    const key = `synthetic-authorization-${++sequence}`;
    const account = `acct_${key}`;
    const org = await db.organization.create({ data: { name: key, stripeConnectAccountId: account } });
    const property = await db.property.create({ data: { name: key, organizationId: org.id } });
    const reservation = await db.reservation.create({ data: {
      propertyId: property.id, guestName: "Synthetic", guestEmail: `${key}@example.invalid`, guestToken: key,
      checkIn: new Date("2026-01-01T00:00:00Z"), checkOut: new Date("2026-01-02T00:00:00Z"),
      source: "DIRECT_BOOKING", stripeConnectedAccountId: account, currency: "usd", preferredLanguage: "es",
      propertyProtectionRequiredSnapshot: true, propertyProtectionModeSnapshot: "CARD_ON_FILE",
      maxDamageLiabilityAmountSnapshot: 500,
      propertyProtectionPolicySnapshot: { enabled: true, mode: "CARD_ON_FILE", maxDamageLiabilityAmount: 500, currency: "usd" },
      damagePaymentConsent: { accepted: true, mode: "CARD_ON_FILE", maxDamageLiabilityAmount: 500, currency: "usd" },
      damagePaymentMethodStatus: "READY", stripeDamageCustomerId: `cus_${key}`, stripeDamagePaymentMethodId: `pm_${key}`,
    } });
    const damageCase = await db.damageCase.create({ data: {
      reservationId: reservation.id, requestedAmount: 125, approvedAmount: 100.25, currency: "usd",
      description: "Synthetic description", evidence: { notes: "Synthetic notes" },
      status: "GUEST_NOTIFIED", guestResponse: "ACCEPTED", hostApprovedByUserId: "synthetic-host",
      hostApprovedAt: new Date("2026-01-03T00:00:00Z"), guestNotifiedAt: new Date("2026-01-04T00:00:00Z"),
    } });
    return { org, property, reservation, damageCase, guestToken: key };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const terms = (f: Fixture, language?: string) => getTerms({ prisma: db, guestToken: f.guestToken, language });
  const body = (result: Awaited<ReturnType<typeof getTerms>>) => {
    const { action, version, claimRevision, amountMinor, currency, language } = result.terms;
    return { action, version, claimRevision, amountMinor, currency, language, consent: true };
  };
  const submit = (f: Fixture, payload: unknown) => record({ prisma: db, guestToken: f.guestToken, body: payload });
  async function blocked(operation: Promise<unknown>, code?: string) {
    await assert.rejects(operation, (error: unknown) => error instanceof DamagePaymentAuthorizationError && (!code || error.code === code));
  }
  await t.test("legacy ACCEPTED is not consent; exact Spanish consent is durable and retry-safe", async () => {
    const f = await fixture();
    const before = await db.damageCase.findUniqueOrThrow({ where: { id: f.damageCase.id } });
    const current = await terms(f);
    assert.equal(current.authorization, null);
    assert.equal(current.terms.language, "es");
    assert.equal(current.terms.amountMinor, 10025);
    assert.equal(current.terms.evidenceNotes, "Synthetic notes");
    assert.equal(JSON.stringify(current).includes("cus_"), false);
    assert.equal(JSON.stringify(current).includes("acct_"), false);
    const first = await submit(f, body(current));
    const second = await submit(f, body(current));
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.deepEqual(second.authorization, first.authorization);
    assert.equal(first.collectionStatus, "NO_CHARGE_MADE");
    assert.equal((await terms(f)).authorization?.matchesCurrentTerms, true);
    const saved = await db.damageCasePaymentAuthorization.findUniqueOrThrow({ where: { damageCaseId: f.damageCase.id } });
    assert.equal(saved.organizationId, f.org.id);
    assert.equal(saved.connectedAccountId, f.reservation.stripeConnectedAccountId);
    assert.equal(saved.consentText, current.terms.consentText);
    assert.deepEqual(await db.damageCase.findUniqueOrThrow({ where: { id: f.damageCase.id } }), before);
    assert.equal(await db.messageLog.count(), 0);
  });
  await t.test("English opt-in and concurrent double click persist one immutable record", async () => {
    const f = await fixture();
    const current = await terms(f, "en");
    const results = await Promise.all([submit(f, body(current)), submit(f, body(current))]);
    assert.equal(results[0].authorization.id, results[1].authorization.id);
    assert.deepEqual(results.map(r => r.idempotent).sort(), [false, true]);
    assert.equal(await db.damageCasePaymentAuthorization.count({ where: { damageCaseId: f.damageCase.id } }), 1);
    await blocked(submit(f, body(await terms(f, "es"))), "AUTHORIZATION_ALREADY_RECORDED_WITH_DIFFERENT_TERMS");
  });
  await t.test("expiry, nonexistent token, and another tenant's revision are rejected", async () => {
    const f = await fixture();
    const payload = body(await terms(f));
    const other = await fixture();
    await blocked(submit(other, payload), "AUTHORIZATION_TERMS_CHANGED");
    await blocked(getTerms({ prisma: db, guestToken: "not-found" }), "RESERVATION_NOT_FOUND");
    await db.reservation.update({ where: { id: f.reservation.id }, data: { guestTokenExpiresAt: new Date(0) } });
    await blocked(terms(f), "RESERVATION_NOT_FOUND");
    await blocked(submit(f, payload), "RESERVATION_NOT_FOUND");
    assert.equal(await db.damageCasePaymentAuthorization.count({ where: { damageCaseId: f.damageCase.id } }), 0);
  });
  const caseBlocks: Array<[string, Prisma.DamageCaseUpdateInput]> = [
    ["pending response", { guestResponse: "PENDING" }], ["acknowledged", { guestResponse: "ACKNOWLEDGED" }],
    ["disputed", { guestResponse: "DISPUTED" }], ["closed", { status: "CLOSED_NO_CHARGE", closedAt: new Date() }],
    ["unsent", { status: "GUEST_NOTIFICATION_PENDING" }], ["not notified", { guestNotifiedAt: null }],
    ["unapproved", { hostApprovedAt: null }], ["pre-checkout approval", { hostApprovedAt: new Date("2026-01-01") }],
    ["over cap", { requestedAmount: 700, approvedAmount: 600 }], ["currency", { currency: "eur" }],
    ["zero amount", { approvedAmount: 0 }], ["amount above report", { approvedAmount: 126 }],
  ];
  for (const [name, data] of caseBlocks) await t.test(`blocks ${name} at read and write`, async () => {
    const f = await fixture(); const payload = body(await terms(f));
    await db.damageCase.update({ where: { id: f.damageCase.id }, data });
    await blocked(terms(f)); await blocked(submit(f, payload));
  });
  const reservationBlocks: Array<[string, Prisma.ReservationUpdateInput]> = [
    ["before checkout", { checkOut: new Date("2099-01-01") }],
    ["not direct", { source: "AIRBNB", externalProvider: null, stripeCheckoutSessionId: null }],
    ["protection disabled", { propertyProtectionRequiredSnapshot: false }],
    ["card revoked", { damagePaymentMethodStatus: "REVOKED" }],
    ["missing saved method", { stripeDamagePaymentMethodId: null }],
    ["changed reservation account", { stripeConnectedAccountId: "acct_other" }],
    ["missing snapshot", { propertyProtectionPolicySnapshot: Prisma.DbNull }],
    ["booking consent absent", { damagePaymentConsent: Prisma.DbNull }],
    ["limit not consented", { maxDamageLiabilityAmountSnapshot: 600 }],
  ];
  for (const [name, data] of reservationBlocks) await t.test(`blocks ${name}`, async () => {
    const f = await fixture(); const payload = body(await terms(f));
    await db.reservation.update({ where: { id: f.reservation.id }, data });
    await blocked(terms(f)); await blocked(submit(f, payload));
  });
  for (const [name, data] of [
    ["description", { description: "changed" }], ["evidence", { evidence: { notes: "changed" } }],
    ["approved amount", { approvedAmount: 99 }], ["report", { requestedAmount: 126 }],
  ] as Array<[string, Prisma.DamageCaseUpdateInput]>) await t.test(`stale ${name} cannot authorize or overwrite`, async () => {
    const f = await fixture(); const old = body(await terms(f));
    await db.damageCase.update({ where: { id: f.damageCase.id }, data });
    await blocked(submit(f, old), "AUTHORIZATION_TERMS_CHANGED");
    const fresh = body(await terms(f)); await submit(f, fresh);
    await db.damageCase.update({ where: { id: f.damageCase.id }, data: { description: "another revision" } });
    assert.equal((await terms(f)).authorization?.matchesCurrentTerms, false);
    await blocked(submit(f, body(await terms(f))), "AUTHORIZATION_ALREADY_RECORDED_WITH_DIFFERENT_TERMS");
  });
  await t.test("account transfer invalidates terms and saved method replacement changes revision", async () => {
    const f = await fixture(); const payload = body(await terms(f));
    await db.reservation.update({ where: { id: f.reservation.id }, data: { stripeDamagePaymentMethodId: "pm_replaced" } });
    await blocked(submit(f, payload), "AUTHORIZATION_TERMS_CHANGED");
    await db.organization.update({ where: { id: f.org.id }, data: { stripeConnectAccountId: "acct_replaced" } });
    await blocked(terms(f), "CONNECTED_ACCOUNT_MISMATCH");
  });
  await t.test("closure holds case lock; concurrent authorization sees closure and inserts nothing", async () => {
    const f = await fixture(); const payload = body(await terms(f));
    let locked!: () => void; const ready = new Promise<void>(resolve => { locked = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const closing = db.$transaction(async tx => {
      await tx.damageCase.update({ where: { id: f.damageCase.id }, data: { status: "CLOSED_NO_CHARGE", closedAt: new Date() } });
      locked(); await gate;
    });
    await ready;
    const pending = submit(f, payload);
    release(); await closing;
    await blocked(pending, "CASE_NOT_OPEN_FOR_PAYMENT");
    assert.equal(await db.damageCasePaymentAuthorization.count({ where: { damageCaseId: f.damageCase.id } }), 0);
  });
  await t.test("database check constraint rejects invalid stored money", async () => {
    const f = await fixture(); await submit(f, body(await terms(f)));
    await assert.rejects(db.damageCasePaymentAuthorization.update({ where: { damageCaseId: f.damageCase.id }, data: { amountMinor: 0 } }));
    await assert.rejects(db.damageCasePaymentAuthorization.update({ where: { damageCaseId: f.damageCase.id }, data: { currency: "eur" } }));
  });
  await t.test("actual HTTP GET/POST contract persists exact consent through the router", async () => {
    const f = await fixture();
    const app = express(); app.use(express.json()); app.use(damagePaymentAuthorizationRouter(db));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manage/${f.guestToken}/property-protection-case/payment-authorization`;
      const preview = await fetch(`${url}?language=en`);
      assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store");
      const current = await preview.json() as Awaited<ReturnType<typeof getTerms>>;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body(current)) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json() as Awaited<ReturnType<typeof record>>;
      assert.equal(result.authorization.amountMinor, 10025);
      assert.equal(result.collectionStatus, "NO_CHARGE_MADE");
      const saved = await db.damageCasePaymentAuthorization.findUniqueOrThrow({ where: { damageCaseId: f.damageCase.id } });
      assert.equal(saved.language, "en"); assert.equal(saved.consentText, current.terms.consentText);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  await t.test("exact Direct Charge is persisted once and replay is idempotent", async () => {
    const f = await fixture();
    await submit(f, body(await terms(f)));
    const calls: Array<{ params: Stripe.PaymentIntentCreateParams; options: Stripe.RequestOptions }> = [];
    const stripeClient = { paymentIntents: { create: async (
      params: Stripe.PaymentIntentCreateParams,
      options: Stripe.RequestOptions
    ) => {
      calls.push({ params, options });
      return {
        id: "pi_damage_exact_1",
        status: "succeeded",
        amount: params.amount,
        currency: params.currency,
        latest_charge: "ch_damage_exact_1",
        metadata: params.metadata,
      } as Stripe.PaymentIntent;
    } } };
    const input = {
      prisma: db,
      stripeClient,
      organizationId: f.org.id,
      damageCaseId: f.damageCase.id,
      requestedByUserId: "synthetic-host",
      now: new Date("2026-09-25T12:00:00Z"),
    };
    const first = await executeDamageCasePayment(input);
    const replay = await executeDamageCasePayment(input);
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal("idempotent" in replay && replay.idempotent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.amount, 10025);
    assert.equal(calls[0].params.off_session, true);
    assert.equal(calls[0].params.confirm, true);
    assert.equal(calls[0].options.stripeAccount, f.reservation.stripeConnectedAccountId);
    assert.match(String(calls[0].options.idempotencyKey), /^pingo_pp_charge_v1_[a-f0-9]{64}$/);
    assert.equal(await db.damageCasePaymentAttempt.count({ where: { damageCaseId: f.damageCase.id } }), 1);
    assert.equal((await db.damageCase.findUniqueOrThrow({ where: { id: f.damageCase.id } })).status, "CHARGED");
  });
  await t.test("concurrent host clicks produce one provider request", async () => {
    const f = await fixture();
    await submit(f, body(await terms(f)));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const stripeClient = { paymentIntents: { create: async (params: Stripe.PaymentIntentCreateParams) => {
      calls += 1; started(); await gate;
      return { id: "pi_damage_concurrent", status: "succeeded", amount: params.amount,
        currency: params.currency, latest_charge: "ch_damage_concurrent", metadata: params.metadata } as Stripe.PaymentIntent;
    } } };
    const input = { prisma: db, stripeClient, organizationId: f.org.id,
      damageCaseId: f.damageCase.id, requestedByUserId: "synthetic-host",
      now: new Date("2026-09-25T12:00:00Z") };
    const first = executeDamageCasePayment(input);
    await ready;
    const duplicate = await executeDamageCasePayment(input);
    assert.equal("inProgress" in duplicate && duplicate.inProgress, true);
    assert.equal(calls, 1);
    release();
    assert.equal((await first).ok, true);
  });
  await t.test("webhook is authoritative for a processing payment", async () => {
    const f = await fixture();
    await submit(f, body(await terms(f)));
    let created!: Stripe.PaymentIntent;
    const stripeClient = { paymentIntents: { create: async (params: Stripe.PaymentIntentCreateParams) => {
      created = { id: "pi_damage_processing", status: "processing", amount: params.amount,
        currency: params.currency, latest_charge: null, metadata: params.metadata } as Stripe.PaymentIntent;
      return created;
    } } };
    const execution = await executeDamageCasePayment({ prisma: db, stripeClient,
      organizationId: f.org.id, damageCaseId: f.damageCase.id,
      requestedByUserId: "synthetic-host", now: new Date("2026-09-25T12:00:00Z") });
    assert.equal("inProgress" in execution && execution.inProgress, true);
    const succeeded = { ...created, status: "succeeded", latest_charge: "ch_damage_webhook" } as Stripe.PaymentIntent;
    const event = { id: "evt_damage_webhook", type: "payment_intent.succeeded",
      account: f.reservation.stripeConnectedAccountId,
      data: { object: succeeded } } as Stripe.Event;
    const result = await reconcileDamageCasePaymentIntent(db, event, new Date("2026-09-25T12:01:00Z"));
    assert.equal(result.handled, true);
    const attempt = await db.damageCasePaymentAttempt.findUniqueOrThrow({ where: { damageCaseId: f.damageCase.id } });
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(attempt.stripeChargeId, "ch_damage_webhook");
    assert.equal((await db.damageCase.findUniqueOrThrow({ where: { id: f.damageCase.id } })).status, "CHARGED");
  });
  assert.equal(await db.messageLog.count(), 0, "No email or message enqueued");
});
