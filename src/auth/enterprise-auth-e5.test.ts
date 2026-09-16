import assert from "node:assert/strict";
import test from "node:test";
import { generateOpaqueToken, hashOpaqueToken } from "./mfa-core.js";
import { createLoginEmailMfaChallenge, verifyLoginEmailMfaChallenge } from "./mfa-login-challenge.js";
import { observeE5ShadowLogin, resolveE5RuntimeMode } from "./mfa-login-runtime.js";
import { buildTrustedDeviceCookie } from "./trusted-device-cookie.js";

const pepper = "p".repeat(64);

test("E5 defaults to OFF", () => {
  assert.deepEqual(resolveE5RuntimeMode(undefined), {
    mode: "OFF",
    enforceBlocked: false,
    source: "DEFAULT",
  });
});

test("E5 accepts SHADOW without enforcement", () => {
  assert.deepEqual(resolveE5RuntimeMode("shadow"), {
    mode: "SHADOW",
    enforceBlocked: false,
    source: "CONFIGURED",
  });
});

test("E5 blocks ENFORCE by degrading to OFF", () => {
  assert.deepEqual(resolveE5RuntimeMode("ENFORCE"), {
    mode: "OFF",
    enforceBlocked: true,
    source: "CONFIGURED",
  });
});

test("E5 invalid mode fails safe to OFF", () => {
  assert.deepEqual(resolveE5RuntimeMode("unexpected"), {
    mode: "OFF",
    enforceBlocked: false,
    source: "INVALID",
  });
});

test("SHADOW creates an auth session without blocking when no trusted device exists", async () => {
  const writes: Array<{ model: string; args: unknown }> = [];
  const client = {
    authFactor: {
      async findFirst() { return { id: "factor-1" }; },
    },
    trustedDevice: {
      async findFirst() { return null; },
      async update(args: unknown) { writes.push({ model: "trustedDevice.update", args }); return {}; },
    },
    authSession: {
      async create(args: unknown) { writes.push({ model: "authSession.create", args }); return { id: "session-1" }; },
    },
    securityEvent: {
      async create(args: unknown) { writes.push({ model: "securityEvent.create", args }); return {}; },
    },
  };

  const result = await observeE5ShadowLogin(client, {
    userId: "user-1",
    organizationId: "org-1",
    email: "host@example.com",
    tokenVersion: 2,
    now: new Date("2026-09-16T12:00:00.000Z"),
  });

  assert.equal(result.sessionId, "session-1");
  assert.equal(result.trustedDeviceValid, false);
  assert.equal(result.hasVerifiedEmailFactor, true);
  assert.equal(result.wouldRequireEmailOtp, true);
  assert.equal(writes.some((entry) => entry.model === "authSession.create"), true);
  assert.equal(writes.some((entry) => entry.model === "securityEvent.create"), true);
});

test("SHADOW trusted-device lookup uses token hash and refreshes lastUsedAt", async () => {
  const token = generateOpaqueToken(32);
  let lookup: any = null;
  let updated = false;
  const client = {
    authFactor: { async findFirst() { return null; } },
    trustedDevice: {
      async findFirst(args: unknown) { lookup = args; return { id: "td-1" }; },
      async update() { updated = true; return {}; },
    },
    authSession: { async create() { return { id: "session-2" }; } },
    securityEvent: { async create() { return {}; } },
  };

  const result = await observeE5ShadowLogin(client, {
    userId: "user-1",
    organizationId: "org-1",
    email: "host@example.com",
    tokenVersion: 2,
    trustedDeviceToken: token,
    now: new Date("2026-09-16T12:00:00.000Z"),
  });

  assert.equal(result.trustedDeviceValid, true);
  assert.equal(result.wouldRequireEmailOtp, false);
  assert.equal(lookup.where.tokenHash, hashOpaqueToken(token));
  assert.equal(updated, true);
});

test("email login MFA challenge is single-use", async () => {
  let challenge: any = null;
  const factor = { id: "factor-email", status: "PENDING" };
  const client = {
    authFactor: {
      async upsert() { return factor; },
      async update() { factor.status = "VERIFIED"; return {}; },
    },
    mfaChallenge: {
      async create(args: any) {
        challenge = {
          ...args.data,
          consumedAt: null,
        };
        return { id: args.data.id };
      },
      async findUnique() { return challenge; },
      async update(args: any) {
        challenge = { ...challenge, ...args.data };
        return {};
      },
    },
    securityEvent: { async create() { return {}; } },
  };

  const created = await createLoginEmailMfaChallenge(client, {
    userId: "user-1",
    organizationId: "org-1",
    email: "Host@Example.com",
    pepper,
    now: new Date("2026-09-16T12:00:00.000Z"),
  });

  assert.match(created.code, /^\d{6}$/);
  assert.notEqual(created.challengeToken, challenge.challengeTokenHash);

  const verified = await verifyLoginEmailMfaChallenge(client, {
    challengeToken: created.challengeToken,
    code: created.code,
    pepper,
    now: new Date("2026-09-16T12:01:00.000Z"),
  });
  assert.deepEqual(verified, { ok: true, userId: "user-1", factorId: "factor-email" });
  assert.equal(factor.status, "VERIFIED");
  assert.equal(challenge.status, "CONSUMED");

  const replay = await verifyLoginEmailMfaChallenge(client, {
    challengeToken: created.challengeToken,
    code: created.code,
    pepper,
    now: new Date("2026-09-16T12:02:00.000Z"),
  });
  assert.deepEqual(replay, { ok: false, reason: "LOCKED" });
});

test("trusted-device cookie is 30-day HttpOnly and Secure in production", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const cookie = buildTrustedDeviceCookie("opaque-token");
    assert.match(cookie, /^pingo_trusted_device=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=None/);
    assert.match(cookie, /Max-Age=2592000/);
    assert.doesNotMatch(cookie, /Domain=/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
