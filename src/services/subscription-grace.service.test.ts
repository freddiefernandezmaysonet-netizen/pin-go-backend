import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { persistSubscriptionWithGrace } from "./subscription-grace.service.js";
import { prisma } from "../lib/prisma.js";
import { isOrgEntitled } from "./billing.entitlement.js";

type Row = { organizationId: string; stripeSubscriptionId: string; status: string;
  graceUntil: Date | null; currentPeriodEnd: Date | null };

test("five-day grace survives retries, expires on time and resets only after recovery or replacement", async t => {
  let row: Row | null = null;
  let queue = Promise.resolve();
  const requeueCalls: unknown[] = [];
  const tx = { subscription: {
    upsert: async (args: Prisma.SubscriptionUpsertArgs) => {
      row = row ? { ...row, ...args.update } as Row : { currentPeriodEnd: null, ...args.create } as Row;
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      if (!row || row.organizationId !== where.organizationId) return { count: 0 };
      const idMatches = typeof where.stripeSubscriptionId === "string"
        ? row.stripeSubscriptionId === where.stripeSubscriptionId
        : row.stripeSubscriptionId !== where.stripeSubscriptionId.not;
      if (!idMatches || (where.status && row.status !== where.status) ||
          (where.graceUntil === null && row.graceUntil !== null)) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    },
  }, accessGrant: { updateMany: async (args: unknown) => { requeueCalls.push(args); return { count: 0 }; } } };
  const db = { $transaction: (callback: (client: unknown) => Promise<unknown>) => {
    const run = queue.then(() => callback(tx));
    queue = run.then(() => {});
    return run;
  } } as unknown as Pick<PrismaClient, "$transaction">;
  const original = prisma.subscription.findUnique;
  prisma.subscription.findUnique = (async (args: any) => {
    assert.deepEqual(args.select, { status: true, currentPeriodEnd: true, graceUntil: true });
    return row;
  }) as unknown as typeof original;
  t.after(() => { prisma.subscription.findUnique = original; });
  const first = new Date("2026-10-29T10:30:00Z");
  const deadline = new Date("2026-11-03T10:30:00Z");
  const sync = (status: "PAST_DUE" | "ACTIVE" | "CANCELED", at: Date, id = "sub_one") =>
    persistSubscriptionWithGrace(db, {
      where: { organizationId: "org" },
      create: { organizationId: "org", stripeSubscriptionId: id, status },
      update: { stripeSubscriptionId: id, status },
    }, at);

  assert.deepEqual(await isOrgEntitled("org", first), { ok: false, reason: "NO_SUBSCRIPTION" });
  await sync("PAST_DUE", first);
  assert.equal((row as Row | null)?.graceUntil?.toISOString(), deadline.toISOString());
  assert.deepEqual(await isOrgEntitled("org", deadline), { ok: true, reason: "GRACE" });
  assert.deepEqual(await isOrgEntitled("org", new Date(deadline.getTime() + 1)), { ok: false, reason: "GRACE_EXPIRED" });
  // Duplicate delivery and later retries must not buy extra days, even when concurrent.
  await Promise.all([sync("PAST_DUE", first), sync("PAST_DUE", new Date("2026-11-01T10:30:00Z"))]);
  assert.equal((row as Row | null)?.graceUntil?.toISOString(), deadline.toISOString());
  assert.equal(requeueCalls.length, 0);
  await sync("ACTIVE", new Date("2026-11-02T10:30:00Z"));
  assert.deepEqual(requeueCalls, [{
    where: { type: "GUEST", method: "PASSCODE_TIMEBOUND", status: "SUSPENDED",
      lastError: { startsWith: "Blocked by billing: " }, endsAt: { gt: new Date("2026-11-02T10:30:00Z") },
      reservation: { status: "ACTIVE", paymentState: "PAID", checkOut: { gt: new Date("2026-11-02T10:30:00Z") },
        property: { organizationId: "org" } } },
    data: { status: "PENDING", lastError: null },
  }]);
  assert.equal((row as Row | null)?.graceUntil, null);
  assert.deepEqual(await isOrgEntitled("org", new Date("2026-12-01")), { ok: true, reason: "ENTITLED" });
  await sync("PAST_DUE", new Date("2026-12-01T10:30:00Z"));
  assert.equal((row as Row | null)?.graceUntil?.toISOString(), "2026-12-06T10:30:00.000Z");
  await sync("PAST_DUE", new Date("2026-12-02T10:30:00Z"), "sub_replacement");
  assert.equal((row as Row | null)?.graceUntil?.toISOString(), "2026-12-07T10:30:00.000Z");
  await sync("CANCELED", new Date("2026-12-03T10:30:00Z"), "sub_replacement");
  assert.equal((row as Row | null)?.graceUntil, null);
  assert.deepEqual(await isOrgEntitled("org", first), { ok: false, reason: "STATUS_CANCELED" });
  assert.equal(requeueCalls.length, 1);

  // Preserve legacy behavior until a verified event establishes its deadline.
  row = { organizationId: "org", stripeSubscriptionId: "sub_one", status: "PAST_DUE", graceUntil: null, currentPeriodEnd: deadline };
  assert.deepEqual(await isOrgEntitled("org", first), { ok: true, reason: "GRACE" });
  await sync("PAST_DUE", first);
  row.currentPeriodEnd = new Date("2027-01-01");
  assert.deepEqual(await isOrgEntitled("org", new Date(deadline.getTime() + 1)), { ok: false, reason: "GRACE_EXPIRED" });
  await assert.rejects(sync("PAST_DUE", new Date(NaN)), /INVALID_SUBSCRIPTION_EVENT_TIME/);
});
