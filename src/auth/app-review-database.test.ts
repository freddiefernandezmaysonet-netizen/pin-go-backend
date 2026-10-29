import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { provisionAppReviewAccount } from "../services/provision-app-review-account.js";
import { APP_REVIEW_EMAIL, APP_REVIEW_ORGANIZATION_SLUG, createAppReviewSession } from "./app-review-access.js";
import { guardAuthenticatedSession } from "./session-request-guard.js";

const databaseUrl = process.env.PINGO_APP_REVIEW_TEST_DATABASE_URL;
test("App Review provisioning and sessions on disposable PostgreSQL", { skip: !databaseUrl }, async t => {
  // An explicit test URL is mandatory. Never fall back to the production DATABASE_URL.
  assert.equal(new URL(databaseUrl!).pathname, "/pingo_app_review_test");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const fixtureId = `app-review-test-${randomUUID()}`;
  let reviewOrgId: string | undefined;
  let reviewUserId: string | undefined;
  let actorCreated = false;
  t.after(async () => {
    try {
      if (reviewUserId) {
        await db.authSession.deleteMany({ where: { userId: reviewUserId } });
        await db.securityEvent.deleteMany({ where: { userId: reviewUserId } });
      }
      if (reviewOrgId) await db.organization.delete({ where: { id: reviewOrgId } });
      if (actorCreated) await db.organization.delete({ where: { id: fixtureId } });
    } finally { await db.$disconnect(); }
  });
  assert.equal(await db.dashboardUser.count({ where: { email: APP_REVIEW_EMAIL } }), 0, "Disposable DB must not contain a reviewer");
  assert.equal(await db.organization.count({ where: { slug: APP_REVIEW_ORGANIZATION_SLUG } }), 0);
  await db.organization.create({ data: { id: fixtureId, name: "Synthetic operator", dashboardUsers: {
    create: { id: fixtureId, email: `${fixtureId}@example.invalid`, role: "PLATFORM_ADMIN", passwordHash: "unused", isActive: true },
  } } });
  actorCreated = true;
  await t.test("dry run writes nothing", async () => {
    assert.equal((await provisionAppReviewAccount(db, { actorUserId: fixtureId, apply: false })).applied, false);
    assert.equal(await db.dashboardUser.count({ where: { email: APP_REVIEW_EMAIL } }), 0);
  });
  const created = await provisionAppReviewAccount(db, { actorUserId: fixtureId, apply: true });
  assert.equal(created.applied, true);
  if (!created.applied) throw Error("Expected test account");
  reviewOrgId = created.organizationId; reviewUserId = created.userId;
  const user = await db.dashboardUser.findUniqueOrThrow({ where: { id: reviewUserId }, include: { organization: true } });
  const now = new Date();
  const env = { PINGO_APP_REVIEW_ENABLED: "true", PINGO_SESSION_MODE: "ENFORCE",
    PINGO_APP_REVIEW_USER_ID: reviewUserId, PINGO_APP_REVIEW_ORGANIZATION_ID: reviewOrgId,
    PINGO_APP_REVIEW_EXPIRES_AT: new Date(now.getTime() + 60000).toISOString() };
  await t.test("provisioning refuses to modify an existing review account", async () => {
    await assert.rejects(provisionAppReviewAccount(db, { actorUserId: fixtureId, apply: true }), /ALREADY_EXISTS/);
    assert.equal((await db.dashboardUser.findUniqueOrThrow({ where: { id: reviewUserId! } })).passwordHash, user.passwordHash);
  });
  await t.test("commercial connection blocks session creation", async () => {
    await db.organization.update({ where: { id: reviewOrgId! }, data: { stripeCustomerId: "synthetic-customer" } });
    await assert.rejects(createAppReviewSession(db, user, env, null, now), /NOT_ISOLATED/);
    assert.equal(await db.authSession.count({ where: { userId: reviewUserId } }), 0);
    await db.organization.update({ where: { id: reviewOrgId! }, data: { stripeCustomerId: null } });
  });
  await t.test("session and audit persist together and expiration is enforced", async () => {
    const sessionId = await createAppReviewSession(db, user, env, "synthetic-test", now);
    assert.ok(sessionId);
    const session = await db.authSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.absoluteExpiresAt.toISOString(), env.PINGO_APP_REVIEW_EXPIRES_AT);
    assert.equal(session.sessionPolicy, "LEGACY");
    assert.equal(session.trustedDeviceId, null);
    assert.equal(await db.securityEvent.count({ where: { userId: reviewUserId, type: "AUTH_SESSION_CREATED" } }), 1);
    const input = { userId: user.id, organizationId: user.organizationId, tokenVersion: user.tokenVersion,
      sessionId, mode: "ENFORCE" as const, now };
    assert.equal((await guardAuthenticatedSession(db as any, input)).kind, "ALLOW");
    assert.equal((await guardAuthenticatedSession(db as any, { ...input, now: new Date(now.getTime() + 60001) })).kind, "DENY");
  });
});
