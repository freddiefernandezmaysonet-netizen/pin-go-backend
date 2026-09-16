import assert from "node:assert/strict";
import test from "node:test";
import { hashOpaqueToken } from "./mfa-core.js";
import {
  deliverMfaEmailOtp,
  resolveMfaEmailDeliveryMode,
} from "./mfa-email-otp-delivery.js";
import {
  createAuthSession,
  createTrustedDevice,
  type TrustedDeviceSessionClient,
} from "./trusted-device-session.persistence.js";
import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  TRUSTED_DEVICE_TTL_MS,
} from "./session-security.policy.js";

test("MFA email delivery defaults to MOCK", () => {
  assert.equal(resolveMfaEmailDeliveryMode({}), "MOCK");
  assert.equal(resolveMfaEmailDeliveryMode({ PINGO_MFA_EMAIL_DELIVERY: "unexpected" }), "MOCK");
});

test("MOCK mode never invokes sender", async () => {
  let called = false;
  const result = await deliverMfaEmailOtp(
    {
      destination: "host@example.com",
      code: "123456",
      expiresInMinutes: 5,
    },
    {
      env: {},
      sender: async () => {
        called = true;
        return { providerMessageId: "should-not-exist" };
      },
    }
  );

  assert.equal(called, false);
  assert.deepEqual(result, {
    delivered: false,
    mode: "MOCK",
    providerMessageId: null,
  });
});

test("RESEND mode requires explicit provider configuration", async () => {
  await assert.rejects(
    deliverMfaEmailOtp(
      {
        destination: "host@example.com",
        code: "123456",
        expiresInMinutes: 5,
      },
      { env: { PINGO_MFA_EMAIL_DELIVERY: "RESEND" } }
    ),
    /MFA_EMAIL_DELIVERY_CONFIG_MISSING/
  );
});

test("RESEND mode sends normalized email only through injected sender", async () => {
  let captured: { to?: string; html?: string } = {};
  const result = await deliverMfaEmailOtp(
    {
      destination: " Host@Example.COM ",
      code: "654321",
      expiresInMinutes: 5,
    },
    {
      env: {
        PINGO_MFA_EMAIL_DELIVERY: "RESEND",
        RESEND_API_KEY: "test-key",
        EMAIL_FROM: "Pin&Go <security@example.com>",
      },
      sender: async (input) => {
        captured = { to: input.to, html: input.html };
        return { providerMessageId: "msg-1" };
      },
    }
  );

  assert.equal(captured.to, "host@example.com");
  assert.match(captured.html ?? "", /654321/);
  assert.deepEqual(result, {
    delivered: true,
    mode: "RESEND",
    providerMessageId: "msg-1",
  });
});

test("email OTP delivery rejects non-six-digit codes and wrong TTL", async () => {
  const env = {
    PINGO_MFA_EMAIL_DELIVERY: "RESEND",
    RESEND_API_KEY: "test-key",
    EMAIL_FROM: "Pin&Go <security@example.com>",
  };
  const sender = async () => ({ providerMessageId: "msg" });

  await assert.rejects(
    deliverMfaEmailOtp(
      { destination: "host@example.com", code: "12345", expiresInMinutes: 5 },
      { env, sender }
    ),
    /MFA_EMAIL_OTP_INVALID/
  );

  await assert.rejects(
    deliverMfaEmailOtp(
      { destination: "host@example.com", code: "123456", expiresInMinutes: 10 },
      { env, sender }
    ),
    /MFA_EMAIL_OTP_TTL_INVALID/
  );
});

test("trusted device stores only token hash and expires in 30 days", async () => {
  let stored: any = null;
  const client: TrustedDeviceSessionClient = {
    trustedDevice: {
      async create(args) {
        stored = args.data;
        return { id: "td-1" };
      },
    },
    authSession: {
      async create() {
        return { id: "session-unused" };
      },
    },
  };

  const now = new Date("2026-09-16T12:00:00.000Z");
  const result = await createTrustedDevice(client, {
    userId: "user-1",
    userAgent: "Safari",
    now,
  });

  assert.equal(result.trustedDeviceId, "td-1");
  assert.equal(result.expiresAt.getTime() - now.getTime(), TRUSTED_DEVICE_TTL_MS);
  assert.equal(stored.tokenHash, hashOpaqueToken(result.token));
  assert.notEqual(stored.tokenHash, result.token);
  assert.equal(Object.values(stored).includes(result.token), false);
});

test("auth session persists 12-hour absolute expiry with current activity", async () => {
  let stored: any = null;
  const client: TrustedDeviceSessionClient = {
    trustedDevice: {
      async create() {
        return { id: "td-unused" };
      },
    },
    authSession: {
      async create(args) {
        stored = args.data;
        return { id: "session-1" };
      },
    },
  };

  const now = new Date("2026-09-16T12:00:00.000Z");
  const result = await createAuthSession(client, {
    userId: "user-1",
    organizationId: "org-1",
    tokenVersion: 3,
    trustedDeviceId: "td-1",
    now,
  });

  assert.equal(result.sessionId, "session-1");
  assert.equal(result.absoluteExpiresAt.getTime() - now.getTime(), SESSION_ABSOLUTE_TIMEOUT_MS);
  assert.equal(stored.authenticatedAt.getTime(), now.getTime());
  assert.equal(stored.lastActivityAt.getTime(), now.getTime());
  assert.equal(stored.trustedDeviceId, "td-1");
});
