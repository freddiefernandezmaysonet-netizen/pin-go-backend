import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { randomUUID } from "node:crypto";

process.env.STRIPE_SECRET_KEY ??= "sk_test_offline_signup_fixture";
const { maybeCompleteSignupOnboarding } = await import("./stripe.webhook.js");

test("concurrent signup confirmations create one organization with its administrator", async () => {
  let pending: any = { id: "pending", email: "synthetic@example.invalid", organizationName: "Synthetic signup",
    passwordHash: "synthetic-hash", fullName: "Synthetic Host", status: "CHECKOUT_CREATED", organizationId: null };
  const organizations: string[] = [], users: any[] = [];
  let queue = Promise.resolve();
  const find = async () => ({ ...pending });
  const update = async ({ data }: any) => (pending = { ...pending, ...data });
  const tx = {
    $queryRaw: async () => [{ id: pending.id }],
    pendingSignup: { findUnique: find, update },
    organization: { create: async () => { const id = `org-${organizations.length + 1}`; organizations.push(id); return { id }; }, update: async () => ({}) },
    dashboardUser: { findUnique: async () => users[0] ?? null, create: async ({ data }: any) => { users.push(data); return data; } },
  };
  const db = { pendingSignup: tx.pendingSignup, $transaction: (run: (tx: unknown) => Promise<unknown>) => {
    const work = queue.then(() => run(tx)); queue = work.then(() => {}, () => {}); return work;
  } } as unknown as PrismaClient;
  const session = { id: "cs_test_signup_fixture", mode: "subscription", payment_status: "paid",
    customer: "cus_fixture", subscription: "sub_fixture", metadata: { pendingSignupId: pending.id } } as unknown as Stripe.Checkout.Session;
  await Promise.all([maybeCompleteSignupOnboarding(session, db), maybeCompleteSignupOnboarding(session, db)]);
  assert.equal(organizations.length, 1, "one checkout must not leave an orphan organization");
  assert.equal(users.length, 1);
  assert.equal(pending.organizationId, users[0].organizationId);
  assert.equal(pending.status, "COMPLETED");
  await maybeCompleteSignupOnboarding(session, db);
  assert.equal(organizations.length, 1);
});

test("real PostgreSQL serializes repeated signup confirmations without orphan organizations", {
  skip: !process.env.SIGNUP_TEST_DATABASE_URL,
}, async () => {
  const databaseUrl = process.env.SIGNUP_TEST_DATABASE_URL!;
  const url = new URL(databaseUrl);
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.DATABASE_URL, databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/pingo_signup_test");
  assert.equal(url.search, "");
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  const suffix = randomUUID().replaceAll("-", "");
  const organizationName = `Synthetic signup ${suffix}`;
  const email = `${suffix}@example.invalid`;
  let pendingId: string | undefined;
  try {
    const pending = await db.pendingSignup.create({ data: { email, organizationName,
      passwordHash: "synthetic-never-used-for-login", status: "CHECKOUT_CREATED",
      stripeCheckoutSessionId: `cs_test_${suffix}` } });
    pendingId = pending.id;
    const session = { id: pending.stripeCheckoutSessionId, mode: "subscription", payment_status: "paid",
      customer: `cus_${suffix}`, subscription: `sub_${suffix}`, metadata: { pendingSignupId: pending.id } } as unknown as Stripe.Checkout.Session;
    await Promise.all(Array.from({ length: 8 }, () => maybeCompleteSignupOnboarding(session, db)));
    await maybeCompleteSignupOnboarding(session, db);
    const saved = await db.pendingSignup.findUniqueOrThrow({ where: { id: pending.id } });
    const organizations = await db.organization.findMany({ where: { name: organizationName }, include: { dashboardUsers: true } });
    assert.equal(organizations.length, 1);
    assert.equal(organizations[0]!.dashboardUsers.length, 1);
    assert.equal(organizations[0]!.dashboardUsers[0]!.email, email);
    assert.equal(saved.organizationId, organizations[0]!.id);
    assert.equal(saved.status, "COMPLETED");
  } finally {
    if (pendingId) await db.pendingSignup.deleteMany({ where: { id: pendingId } });
    await db.organization.deleteMany({ where: { name: organizationName } });
    await db.$disconnect();
  }
});
