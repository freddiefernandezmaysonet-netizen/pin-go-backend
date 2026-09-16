import assert from "node:assert/strict";
import test from "node:test";
import { hashOpaqueToken } from "./mfa-core.js";
import {
  evaluateE6EffectiveMode,
  findValidE6TrustedDevice,
  resolveE6RuntimeMode,
} from "./mfa-canary-runtime.js";
import {
  beginE6EmailCanary,
  resendE6EmailCanary,
} from "./mfa-canary-flow.js";

const pepper = "e6-pepper-" + "p".repeat(64);
const deliveryEnv = {
  PINGO_MFA_EMAIL_DELIVERY: "RESEND",
  RESEND_API_KEY: "test-api-key",
  EMAIL_FROM: "Pin&Go <security@example.com>",
};

const sender = async () => ({ providerMessageId: "msg-test" });

function configuredCanaryEnv() {
  return {
    PINGO_MFA_MODE: "CANARY",
    PINGO_MFA_CANARY_USER_IDS: "user-1,user-2",
    PINGO_MFA_OTP_PEPPER: pepper,
    PINGO_MFA_EMAIL_DELIVERY: "RESEND",
    RESEND_API_KEY: "test-api-key",
    EMAIL_FROM: "Pin&Go <security@example.com>",
  };
}

test("E6 accepts CANARY but still blocks ENFORCE", () => {
  assert.deepEqual(resolveE6RuntimeMode("canary"), {
    mode: "CANARY",
    enforceBlocked: false,
    source: "CONFIGURED",
  });
  assert.deepEqual(resolveE6RuntimeMode("ENFORCE"), {
    mode: "OFF",
    enforceBlocked: true,
    source: "CONFIGURED",
  });
});

test("CANARY without allowlist degrades to SHADOW", () => {
  const result = evaluateE6EffectiveMode("user-1", {
    ...configuredCanaryEnv(),
    PINGO_MFA_CANARY_USER_IDS: "",
  });
  assert.equal(result.mode, "SHADOW");
  assert.equal(result.reason, "CANARY_ALLOWLIST_EMPTY");
});

test("non-selected user remains SHADOW while canary is ready", () => {
  const result = evaluateE6EffectiveMode("user-99", configuredCanaryEnv());
  assert.equal(result.mode, "SHADOW");
  assert.equal(result.canaryReady, true);
  assert.equal(result.canarySelected, false);
  assert.equal(result.reason, "CANARY_USER_NOT_SELECTED");
});

test("selected user degrades to SHADOW when pepper is missing", () => {
  const result = evaluateE6EffectiveMode("user-1", {
    ...configuredCanaryEnv(),
    PINGO_MFA_OTP_PEPPER: "short",
  });
  assert.equal(result.mode, "SHADOW");
  assert.equal(result.reason, "CANARY_PEPPER_MISSING");
});

test("selected user degrades to SHADOW when email delivery is not RESEND", () => {
  const result = evaluateE6EffectiveMode("user-1", {
    ...configuredCanaryEnv(),
    PINGO_MFA_EMAIL_DELIVERY: "MOCK",
  });
  assert.equal(result.mode, "SHADOW");
  assert.equal(result.reason, "CANARY_DELIVERY_NOT_RESEND");
});

test("selected fully configured user enters CANARY", () => {
  const result = evaluateE6EffectiveMode("user-1", configuredCanaryEnv());
  assert.equal(result.mode, "CANARY");
  assert.equal(result.canaryReady, true);
  assert.equal(result.canarySelected, true);
  assert.equal(result.reason, "CANARY_ACTIVE");
});

test("trusted-device canary lookup uses only token hash", async () => {
  let lookup: any = null;
  let update: any = null;
  const client = {
    trustedDevice: {
      async findFirst(args: unknown) {
        lookup = args;
        return { id: "trusted-1" };
      },
      async update(args: unknown) {
        update = args;
        return {};
      },
    },
  };

  const token = "opaque-device-token";
  const result = await findValidE6TrustedDevice(client, {
    userId: "user-1",
    token,
    now: new Date("2026-09-16T14:00:00.000Z"),
  });

  assert.deepEqual(result, { id: "trusted-1" });
  assert.equal(lookup.where.tokenHash, hashOpaqueToken(token));
  assert.equal(lookup.where.revokedAt, null);
  assert.equal(update.where.id, "trusted-1");
});

test("begin canary creates challenge and sends only through injected sender", async () => {
  let challenge: any = null;
  const events: any[] = [];
  let sendCount = 0;

  const client = {
    authFactor: {
      async upsert() {
        return { id: "factor-1", status: "PENDING" };
      },
      async findUnique() {
        return { id: "factor-1", destination: "host@example.com" };
      },
      async update() {
        return {};
      },
    },
    mfaChallenge: {
      async create(args: any) {
        challenge = { ...args.data, consumedAt: null };
        return { id: args.data.id };
      },
      async findUnique() {
        return challenge;
      },
      async update(args: any) {
        challenge = { ...challenge, ...args.data };
        return {};
      },
    },
    securityEvent: {
      async create(args: any) {
        events.push(args.data);
        return {};
      },
    },
  };

  const result = await beginE6EmailCanary(
    client,
    {
      userId: "user-1",
      organizationId: "org-1",
      email: "Host@Example.com",
      pepper,
      now: new Date("2026-09-16T14:00:00.000Z"),
    },
    {
      env: deliveryEnv,
      sender: async (input) => {
        sendCount += 1;
        assert.equal(input.to, "host@example.com");
        assert.match(input.html, /\d{6}/);
        return sender();
      },
    }
  );

  assert.equal(sendCount, 1);
  assert.equal(result.delivered, true);
  assert.equal(result.maskedDestination.endsWith("@example.com"), true);
  assert.notEqual(result.challengeToken, challenge.challengeTokenHash);
  assert.equal(events.some((event) => event.type === "MFA_CHALLENGE_CREATED"), true);
  assert.equal(events.some((event) => event.type === "MFA_CHALLENGE_SENT"), true);
});

test("resend enforces cooldown then rotates OTP material", async () => {
  let challenge: any = null;
  let oldOtpHash = "";
  let sendCount = 0;

  const client = {
    authFactor: {
      async upsert() {
        return { id: "factor-1", status: "PENDING" };
      },
      async findUnique() {
        return { id: "factor-1", destination: "host@example.com" };
      },
      async update() {
        return {};
      },
    },
    mfaChallenge: {
      async create(args: any) {
        challenge = { ...args.data, consumedAt: null };
        oldOtpHash = args.data.otpHash;
        return { id: args.data.id };
      },
      async findUnique() {
        return challenge;
      },
      async update(args: any) {
        challenge = { ...challenge, ...args.data };
        return {};
      },
    },
    securityEvent: {
      async create() {
        return {};
      },
    },
  };

  const created = await beginE6EmailCanary(
    client,
    {
      userId: "user-1",
      organizationId: "org-1",
      email: "host@example.com",
      pepper,
      now: new Date("2026-09-16T14:00:00.000Z"),
    },
    {
      env: deliveryEnv,
      sender: async () => {
        sendCount += 1;
        return sender();
      },
    }
  );

  const cooldown = await resendE6EmailCanary(
    client,
    {
      challengeToken: created.challengeToken,
      organizationId: "org-1",
      pepper,
      now: new Date("2026-09-16T14:00:30.000Z"),
    },
    { env: deliveryEnv, sender }
  );
  assert.deepEqual(cooldown, {
    ok: false,
    reason: "COOLDOWN",
    retryAfterSeconds: 30,
  });

  const resent = await resendE6EmailCanary(
    client,
    {
      challengeToken: created.challengeToken,
      organizationId: "org-1",
      pepper,
      now: new Date("2026-09-16T14:01:01.000Z"),
    },
    {
      env: deliveryEnv,
      sender: async () => {
        sendCount += 1;
        return sender();
      },
    }
  );

  assert.equal(resent.ok, true);
  assert.equal(sendCount, 2);
  assert.notEqual(challenge.otpHash, oldOtpHash);
  assert.equal(challenge.attemptCount, 0);
});
