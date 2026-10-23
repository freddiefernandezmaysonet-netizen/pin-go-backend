import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { appReviewDeadline, createAppReviewSession, type ReviewIdentity } from "./app-review-access.js";

const now = new Date("2026-10-23T12:00:00.000Z");
const user: ReviewIdentity = { id: "review-user", organizationId: "review-org", email: "apple-review@pin-ngo.com",
  role: "ORG_ADMIN", isActive: true, tokenVersion: 1, organization: { slug: "pin-go-app-review" } };
const env = { PINGO_APP_REVIEW_ENABLED: "true", PINGO_SESSION_MODE: "ENFORCE",
  PINGO_APP_REVIEW_USER_ID: user.id, PINGO_APP_REVIEW_ORGANIZATION_ID: user.organizationId,
  PINGO_APP_REVIEW_EXPIRES_AT: "2026-11-06T12:00:00.000Z" };

test("matching reviewer receives a bounded exception", () => {
  assert.equal(appReviewDeadline(user, env, now)?.toISOString(), env.PINGO_APP_REVIEW_EXPIRES_AT);
});
for (const [label, patch] of Object.entries({
  "other user": { id: "other" }, "other organization": { organizationId: "real" },
  "other email": { email: "host@example.com" }, "platform admin": { role: "PLATFORM_ADMIN" },
  "legacy admin": { role: "ADMIN" }, "disabled account": { isActive: false },
  "renamed organization": { organization: { slug: "serena-studio" } }, "missing organization": { organization: null },
})) test(`no exception for ${label}`, () => assert.equal(appReviewDeadline({ ...user, ...patch }, env, now), null));

for (const key of Object.keys(env)) test(`configuration missing ${key} does not enable exception`, () => {
  const incomplete: Record<string, string> = { ...env }; delete incomplete[key];
  assert.equal(appReviewDeadline(user, incomplete, now), null);
});
for (const expires of ["", "not-a-date", "2026-11-01", now.toISOString(), "2026-10-22T12:00:00.000Z",
  "2026-12-01T12:00:00.000Z", "2026-02-30T12:00:00.000Z"])
  test(`invalid or expired deadline ${expires}`, () => assert.equal(appReviewDeadline(user, { ...env, PINGO_APP_REVIEW_EXPIRES_AT: expires }, now), null));

function fixture(isolated = true, auditFails = false) {
  const calls: { kind: string; args: any }[] = [];
  const tx = {
    organization: { findFirst: async (args: any) => { calls.push({ kind: "isolation", args }); return isolated ? { id: user.organizationId } : null; } },
    authSession: { create: async (args: any) => { calls.push({ kind: "session", args }); return { id: "session-1" }; } },
    securityEvent: { create: async (args: any) => { calls.push({ kind: "audit", args }); if (auditFails) throw new Error("audit unavailable"); return {}; } },
  };
  const db = { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as Pick<PrismaClient, "$transaction">;
  return { db, calls };
}
test("ordinary accounts do not query review organization or create sessions", async () => {
  const f = fixture();
  assert.equal(await createAppReviewSession(f.db, { ...user, id: "ordinary" }, env, null, now), null);
  assert.equal(f.calls.length, 0);
});
test("commercial connections or locks deny review login without creating a session", async () => {
  const f = fixture(false);
  await assert.rejects(createAppReviewSession(f.db, user, env, null, now), /NOT_ISOLATED/);
  assert.deepEqual(f.calls.map(c => c.kind), ["isolation"]);
  const where = f.calls[0]!.args.where;
  assert.deepEqual(where.properties, { none: { locks: { some: {} } } });
  assert.deepEqual(where.ttlockAuth, { is: null });
  assert.deepEqual(where.pmsConnections, { none: {} });
  assert.deepEqual(where.subscriptions, { is: null });
  assert.equal(where.stripeCustomerId, null);
  assert.equal(where.stripeConnectAccountId, null);
});
test("session is nonrolling, audited, capped to 24 hours and no trusted device is minted", async () => {
  const f = fixture();
  assert.equal(await createAppReviewSession(f.db, user, env, "test", now), "session-1");
  assert.deepEqual(f.calls.map(c => c.kind), ["isolation", "session", "audit"]);
  const session = f.calls[1]!.args.data;
  assert.equal(session.sessionPolicy, "LEGACY");
  assert.equal(session.trustedDeviceId, undefined);
  assert.equal(session.absoluteExpiresAt.toISOString(), "2026-10-24T12:00:00.000Z");
  assert.equal(f.calls[2]!.args.data.metadata.reason, "APP_REVIEW_TEMPORARY_EXCEPTION");
});
test("session never extends beyond exception expiry", async () => {
  const f = fixture(); const expires = "2026-10-23T13:00:00.000Z";
  await createAppReviewSession(f.db, user, { ...env, PINGO_APP_REVIEW_EXPIRES_AT: expires }, null, now);
  assert.equal(f.calls[1]!.args.data.absoluteExpiresAt.toISOString(), expires);
});
test("audit failures fail login instead of falling back", async () => {
  await assert.rejects(createAppReviewSession(fixture(true, true).db, user, env, null, now), /audit unavailable/);
});
test("login integration preserves password validation before the exception", () => {
  const route = readFileSync(new URL("../routes/auth.routes.ts", import.meta.url), "utf8");
  const call = route.indexOf("boundSessionId = await createAppReviewSession");
  assert.ok(call > route.indexOf("if (!ok)"));
  assert.ok(call > route.indexOf("if (!user.isActive)"));
  assert.match(route, /if \(!boundSessionId && requiresE7MfaChallenge\(e6Runtime\)\)/);
});
