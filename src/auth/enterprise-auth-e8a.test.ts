import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  observeSessionBindingShadow,
  revokeBoundSessionOnLogout,
} from "./session-binding-shadow.js";

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
  const events: unknown[] = [];
  const updates: unknown[] = [];
  return {
    events,
    updates,
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

test("E8A treats JWTs without sid as legacy and never blocks them", async () => {
  const { client } = clientWithSession(null);
  const result = await observeSessionBindingShadow(client, {
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    sessionId: null,
    now: new Date("2026-09-16T12:15:00.000Z"),
  });

  assert.deepEqual(result, {
    bound: false,
    valid: true,
    sessionId: null,
    reason: "UNBOUND_LEGACY",
  });
});

test("E8A recognizes a bound active AuthSession", async () => {
  const { client } = clientWithSession(activeSession());
  const result = await observeSessionBindingShadow(client, {
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    sessionId: "session-1",
    now: new Date("2026-09-16T12:20:00.000Z"),
  });

  assert.equal(result.bound, true);
  assert.equal(result.valid, true);
  assert.equal(result.reason, "ACTIVE");
});

test("E8A reports idle timeout in shadow without enforcing it", async () => {
  const { client } = clientWithSession(activeSession());
  const result = await observeSessionBindingShadow(client, {
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    sessionId: "session-1",
    now: new Date("2026-09-16T12:40:00.000Z"),
  });

  assert.equal(result.bound, true);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "IDLE_TIMEOUT");
});

test("E8A reports revoked and identity-mismatched sessions", async () => {
  const revoked = clientWithSession(activeSession({
    revokedAt: new Date("2026-09-16T12:12:00.000Z"),
  }));
  const revokedResult = await observeSessionBindingShadow(revoked.client, {
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    sessionId: "session-1",
    now: new Date("2026-09-16T12:20:00.000Z"),
  });
  assert.equal(revokedResult.reason, "SESSION_REVOKED");

  const mismatched = clientWithSession(activeSession({ userId: "other-user" }));
  const mismatchResult = await observeSessionBindingShadow(mismatched.client, {
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    sessionId: "session-1",
    now: new Date("2026-09-16T12:20:00.000Z"),
  });
  assert.equal(mismatchResult.reason, "SESSION_IDENTITY_MISMATCH");
});

test("E8A logout revokes exactly the bound session and records the event", async () => {
  const { client, updates, events } = clientWithSession(activeSession());
  const result = await revokeBoundSessionOnLogout(client, {
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    sessionId: "session-1",
    userAgent: "test-agent",
    now: new Date("2026-09-16T12:25:00.000Z"),
  });

  assert.deepEqual(result, { revoked: true, reason: "REVOKED" });
  assert.equal(updates.length, 1);
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(updates[0]), /LOGOUT/);
  assert.match(JSON.stringify(events[0]), /AUTH_SESSION_REVOKED/);
});

test("E8A session binding remains preserved when E8B supersedes middleware policy", () => {
  const tokenSource = readFileSync("src/auth/session-bound-token.ts", "utf8");
  const middlewareSource = readFileSync("src/middleware/requireAuth.ts", "utf8");
  const loginSource = readFileSync("src/routes/auth.routes.ts", "utf8");
  const mfaSource = readFileSync("src/auth/mfa-login.routes.ts", "utf8");

  assert.match(tokenSource, /sid\?: string/);
  assert.match(tokenSource, /decoded\.sid/);
  assert.match(middlewareSource, /guardAuthenticatedSession/);
  assert.match(middlewareSource, /WOULD_DENY/);
  assert.match(loginSource, /signSessionBoundAuthToken/);
  assert.match(loginSource, /boundSessionId/);
  assert.match(loginSource, /revokeBoundSessionOnLogout/);
  assert.match(mfaSource, /signSessionBoundAuthToken/);
  assert.match(mfaSource, /session\.sessionId/);
});
