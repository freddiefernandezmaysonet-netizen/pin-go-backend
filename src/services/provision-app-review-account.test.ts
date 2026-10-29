import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { provisionAppReviewAccount } from "./provision-app-review-account.js";

function fixture(options: { inactive?: boolean; role?: string; existingUser?: boolean; existingOrg?: boolean } = {}) {
  let created: any;
  const tx = {
    dashboardUser: { findUnique: async ({ where }: any) => where.id
      ? { id: "operator", role: options.role ?? "PLATFORM_ADMIN", isActive: !options.inactive }
      : options.existingUser ? { id: "existing" } : null },
    organization: {
      findUnique: async () => options.existingOrg ? { id: "existing-org" } : null,
      create: async (args: any) => { created = args.data; return { id: "new-org", dashboardUsers: [{ id: "new-review-user" }] }; },
    },
  };
  const db = { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as Pick<PrismaClient, "$transaction">;
  return { db, get created() { return created; } };
}
test("dry run validates operator and collisions but creates nothing", async () => {
  const f = fixture();
  const result = await provisionAppReviewAccount(f.db, { actorUserId: "operator", apply: false });
  assert.equal(result.applied, false);
  assert.equal(result.email, "apple-review@pin-ngo.com");
  assert.equal(f.created, undefined);
});
for (const options of [{ inactive: true }, { role: "ORG_ADMIN" }, { role: "MEMBER" }])
  test(`refuses operator ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(provisionAppReviewAccount(f.db, { actorUserId: "operator", apply: true }), /PLATFORM_ADMIN_REQUIRED/);
    assert.equal(f.created, undefined);
  });
for (const options of [{ existingUser: true }, { existingOrg: true }])
  test(`never repurposes existing account or organization ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(provisionAppReviewAccount(f.db, { actorUserId: "operator", apply: true }), /ALREADY_EXISTS/);
    assert.equal(f.created, undefined);
  });
test("creates only a new organization and ORG_ADMIN, with no recoverable password output", async () => {
  const f = fixture();
  const result = await provisionAppReviewAccount(f.db, { actorUserId: "operator", apply: true });
  assert.equal(result.applied, true);
  assert.equal(f.created.publicBookingEnabled, false);
  assert.equal(f.created.pinAIEnabled, false);
  assert.equal(f.created.dashboardUsers.create.role, "ORG_ADMIN");
  assert.match(f.created.dashboardUsers.create.passwordHash, /^\$2[aby]\$/);
  assert.deepEqual(Object.keys(f.created).sort(), ["dashboardUsers", "name", "pinAIEnabled", "publicBookingEnabled", "slug"]);
  assert.equal(JSON.stringify(result).includes("password"), false);
});
