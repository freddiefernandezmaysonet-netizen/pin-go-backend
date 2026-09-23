import assert from "node:assert/strict";
import test from "node:test";
import { provisionStripeConnectAccount as provision } from "./stripe-connect-provisioning.service.js";

function fixture() {
  const orgs = new Map<string, any>([["org-a", { stripeConnectAccountId: null }], ["org-b", { stripeConnectAccountId: null }]]);
  const rows = new Map<string, any>();
  let creates = 0;
  let failCreate = false;
  let failSave = false;
  let failAttach = false;
  const accounts = new Map<string, any>();
  const db: any = {
    organization: {
      findUniqueOrThrow: async ({ where }: any) => ({ ...orgs.get(where.id) }),
      updateMany: async ({ where, data }: any) => {
        if (failAttach) throw new Error("simulated DB interruption");
        const org = orgs.get(where.id);
        if (org.stripeConnectAccountId && org.stripeConnectAccountId !== data.stripeConnectAccountId) return { count: 0 };
        Object.assign(org, data);
        return { count: 1 };
      },
    },
    stripeConnectProvisioning: {
      findUnique: async ({ where }: any) => rows.get(where.organizationId) ?? null,
      create: async ({ data }: any) => {
        if (rows.has(data.organizationId)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = { ...data, state: "CLAIMED", accountId: null };
        rows.set(data.organizationId, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        if (failSave && data.state === "ACCOUNT_CREATED") throw new Error("simulated result persistence loss");
        const row = rows.get(where.organizationId);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = rows.get(where.organizationId);
        if (row.state !== where.state) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    $transaction: async (callback: any) => callback(db),
  };
  const stripe: any = { accounts: {
    create: async (params: any, options: any) => {
      creates++;
      assert.equal(rows.get(params.metadata.organizationId).state, "CLAIMED");
      assert.equal(options.idempotencyKey, rows.get(params.metadata.organizationId).idempotencyKey);
      if (failCreate) throw new Error("simulated timeout after provider may have created account");
      const account = { id: `acct_${params.metadata.organizationId}`, metadata: params.metadata, details_submitted: false };
      accounts.set(account.id, account);
      return account;
    },
    retrieve: async (id: string) => accounts.get(id),
  } };
  const call = (organizationId = "org-a") => provision(organizationId, {
    db, stripe, params: { metadata: { organizationId } },
    validate: (account: any, id: string) => {
      if (!account || account.deleted || account.id !== id || account.metadata.organizationId !== organizationId) throw new Error("ownership mismatch");
      return account;
    },
  });
  return { call, orgs, rows, accounts, get creates() { return creates; },
    failCreate: () => { failCreate = true; }, failSave: () => { failSave = true; },
    setFailAttach: (value: boolean) => { failAttach = value; } };
}

test("concurrent requests create at most one account; later request reuses it", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.call(), f.call(), f.call()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.creates, 1);
  assert.equal(f.rows.get("org-a").state, "ATTACHED");
  await f.call();
  assert.equal(f.creates, 1);
});
test("unknown provider outcome stays blocked on every subsequent request", async () => {
  const f = fixture(); f.failCreate();
  await assert.rejects(f.call(), { code: "STRIPE_CONNECT_CREATION_REVIEW_REQUIRED" });
  for (let i = 0; i < 3; i++) await assert.rejects(f.call(), { code: "STRIPE_CONNECT_CREATION_REVIEW_REQUIRED" });
  assert.equal(f.creates, 1);
});
test("crash leaving CLAIMED, even beyond idempotency retention, never recreates", async () => {
  const f = fixture();
  f.rows.set("org-a", { state: "CLAIMED", accountId: null, createdAt: new Date(0) });
  await assert.rejects(f.call(), { code: "STRIPE_CONNECT_CREATION_REVIEW_REQUIRED" });
  assert.equal(f.creates, 0);
});
test("provider success followed by result persistence failure never recreates", async () => {
  const f = fixture(); f.failSave();
  await assert.rejects(f.call()); await assert.rejects(f.call());
  assert.equal(f.creates, 1);
  assert.equal(f.orgs.get("org-a").stripeConnectAccountId, null);
});
test("persisted provider result recovers attachment without another creation", async () => {
  const f = fixture(); f.setFailAttach(true);
  await assert.rejects(f.call());
  assert.equal(f.rows.get("org-a").state, "ACCOUNT_CREATED");
  f.setFailAttach(false); await f.call();
  assert.equal(f.creates, 1);
  assert.equal(f.orgs.get("org-a").stripeConnectAccountId, "acct_org-a");
});
test("organizations have separate attempts and keys", async () => {
  const f = fixture(); await Promise.all([f.call(), f.call("org-b")]);
  assert.equal(f.creates, 2);
  assert.notEqual(f.rows.get("org-a").idempotencyKey, f.rows.get("org-b").idempotencyKey);
});
test("existing foreign account fails ownership validation without replacement", async () => {
  const f = fixture();
  f.orgs.get("org-a").stripeConnectAccountId = "acct_foreign";
  f.accounts.set("acct_foreign", { id: "acct_foreign", metadata: { organizationId: "org-b" } });
  await assert.rejects(f.call(), /ownership mismatch/);
  assert.equal(f.creates, 0);
  assert.equal(f.orgs.get("org-a").stripeConnectAccountId, "acct_foreign");
});
