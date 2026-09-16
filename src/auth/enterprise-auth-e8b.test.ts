import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  expireBoundSession,
  inspectBoundSession,
  resolveSessionEnforcementMode,
  touchBoundSessionHumanActivity,
} from "./session-enforcement-runtime.js";

function activeSession(overrides: Partial<{
  id: string;
  userId: string;
  organizationId: string;
  tokenVersion: number;
  authenticatedAt: Date;
  lastActivityAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}> = {}) {
  return {
    id: "session-1",
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    authenticatedAt: new Date("2026-09-16T12:00:00.000Z"),
    lastActivityAt: new Date("2026-09-16T12:10:00.000Z"),
    absoluteExpiresAt: new Date("2026-09-17T00:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  };
}

function clientWithSession(row: ReturnType<typeof activeSession> | null) {
  const updates: unknown[] = [];
  const events: unknown[] = [];
  return {
    updates,
    events,
    client: {
      authSession: {
        async findUnique() {
          return row;
        },
        async updateMany(args: unknown) {
          updates.push(args);
          return { count: row ? 1 : 0 };
        },
      },
      securityEvent: {
        async create(args: unknown) {
          events.push(args);
          return {};
        },
      },
    },
  };
}

test("E8B session mode defaults safely to SHADOW", () => {
  assert.equal(resolveSessionEnforcementMode(undefined), "SHADOW");
  assert.equal(resolveSessionEnforcementMode("garbage"), "SHADOW");
  assert.equal(resolveSessionEnforcementMode("ENFORCE"), "ENFORCE");
});

test("E8B legacy JWT is explicitly unbound", async () => {
  const { client } = clientWithSession(null);
  const result = await inspectBoundSession(client, {
    sessionId: null,
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
  });
  assert.equal(result.valid, false);
  assert.equal(result.bound, false);
  assert.equal(result.reason, "UNBOUND_LEGACY");
});

test("E8B inspection does not touch activity on ordinary protected requests", async () => {
  const { client, updates } = clientWithSession(activeSession());
  const result = await inspectBoundSession(client, {
    sessionId: "session-1",
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    now: new Date("2026-09-16T12:20:00.000Z"),
  });
  assert.equal(result.reason, "ACTIVE");
  assert.equal(updates.length, 0);
});

test("E8B human activity touch is throttled and never revives idle sessions", async () => {
  const active = clientWithSession(activeSession());
  const touched = await touchBoundSessionHumanActivity(active.client, {
    sessionId: "session-1",
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    now: new Date("2026-09-16T12:20:00.000Z"),
  });
  assert.equal(touched.valid, true);
  assert.equal(touched.touched, true);
  assert.equal(active.updates.length, 1);

  const idle = clientWithSession(activeSession());
  const stale = await touchBoundSessionHumanActivity(idle.client, {
    sessionId: "session-1",
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    now: new Date("2026-09-16T12:40:00.000Z"),
  });
  assert.equal(stale.valid, false);
  assert.equal(stale.reason, "IDLE_TIMEOUT");
  assert.equal(stale.touched, false);
  assert.equal(idle.updates.length, 0);
});

test("E8B expiration terminalizes once and records AUTH_SESSION_EXPIRED", async () => {
  const { client, updates, events } = clientWithSession(activeSession());
  const result = await expireBoundSession(client, {
    sessionId: "session-1",
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    reason: "IDLE_TIMEOUT",
    userAgent: "test-agent",
    now: new Date("2026-09-16T12:40:00.000Z"),
  });
  assert.deepEqual(result, { expired: true, eventRecorded: true });
  assert.equal(updates.length, 1);
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(updates[0]), /IDLE_TIMEOUT/);
  assert.match(JSON.stringify(events[0]), /AUTH_SESSION_EXPIRED/);
});

test("E8B runtime source preserves MFA and separates SHADOW from ENFORCE", () => {
  const middleware = readFileSync("src/middleware/requireAuth.ts", "utf8");
  const routes = readFileSync("src/routes/auth.routes.ts", "utf8");
  const runtime = readFileSync("src/auth/session-enforcement-runtime.ts", "utf8");

  assert.match(runtime, /PINGO_SESSION_MODE/);
  assert.match(runtime, /"SHADOW"/);
  assert.match(runtime, /"ENFORCE"/);
  assert.match(middleware, /SESSION_REAUTH_REQUIRED/);
  assert.match(middleware, /SESSION_EXPIRED/);
  assert.match(middleware, /SESSION_VALIDATION_UNAVAILABLE/);
  assert.match(routes, /\/auth\/session\/activity/);
  assert.match(routes, /touchBoundSessionHumanActivity/);
  assert.doesNotMatch(runtime, /PINGO_MFA_MODE/);
});
