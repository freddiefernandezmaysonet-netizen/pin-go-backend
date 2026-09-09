import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOtaChannelLifecycleRegistrationApplyConfirmation,
  resolveOtaChannelLifecycleWebhookRegistrationConfig,
} from "./channex-channel-lifecycle-webhook-registration.config.js";
import {
  OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
  OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER,
} from "./channex-channel-lifecycle-webhook.contract.js";
import {
  ChannexChannelLifecycleWebhookRegistrationError,
  executeChannexChannelLifecycleWebhookRegistration,
  planChannexChannelLifecycleWebhookRegistration,
  type ChannexChannelLifecycleWebhookRegistrationTransport,
  type ChannexWebhookSnapshot,
} from "./channex-channel-lifecycle-webhook-registration.js";

const apiOrigin = "https://staging.channex.io";
const callbackUrl =
  "https://api-staging.example.com/webhooks/ota/channex/channel-lifecycle";
const externalPropertyId = "faf0559d-965f-426c-8303-107b0b1bc5ff";
const otherPropertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const webhookId = "11111111-1111-4111-8111-111111111111";
const otherWebhookId = "22222222-2222-4222-8222-222222222222";
const webhookSecret = "lifecycle-secret";

function config(mode: "PLAN" | "APPLY") {
  const resolved = resolveOtaChannelLifecycleWebhookRegistrationConfig({
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_ENABLED: "true",
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE: mode,
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_CONFIRMATION:
      buildOtaChannelLifecycleRegistrationApplyConfirmation(
        externalPropertyId,
        callbackUrl
      ),
    OTA_CONNECTION_PROVIDER_API_ORIGIN: apiOrigin,
    OTA_CONNECTION_API_KEY: "api-key",
    OTA_CHANNEL_LIFECYCLE_CALLBACK_URL: callbackUrl,
    OTA_CHANNEL_LIFECYCLE_CALLBACK_ALLOWED_ORIGIN:
      "https://api-staging.example.com",
    OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID: externalPropertyId,
    OTA_CHANNEL_WEBHOOK_SECRET: webhookSecret,
  });
  assert.equal(resolved.enabled, true);
  return resolved;
}

function snapshot(
  overrides: Partial<ChannexWebhookSnapshot> = {}
): ChannexWebhookSnapshot {
  return {
    id: webhookId,
    propertyId: externalPropertyId,
    callbackUrl,
    eventMask: "updated_channel",
    headers: {
      [OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER]: webhookSecret,
    },
    isActive: true,
    sendData: true,
    isGlobal: false,
    isProtected: false,
    ...overrides,
  };
}

function transport(initial: readonly ChannexWebhookSnapshot[]) {
  const calls = {
    list: 0,
    put: [] as Array<{ webhookId: string; payload: any }>,
    get: [] as string[],
  };
  let current = [...initial];
  const value: ChannexChannelLifecycleWebhookRegistrationTransport = {
    apiOrigin,
    async listAllWebhooks() {
      calls.list += 1;
      return current;
    },
    async putWebhook(webhookId, payload) {
      calls.put.push({ webhookId, payload });
      current = current.map((item) =>
        item.id === webhookId
          ? {
              ...item,
              propertyId: payload.webhook.property_id,
              callbackUrl: payload.webhook.callback_url,
              eventMask: payload.webhook.event_mask,
              headers: payload.webhook.headers,
              isActive: payload.webhook.is_active,
              sendData: payload.webhook.send_data,
              isGlobal: false,
              isProtected: false,
            }
          : item
      );
    },
    async getWebhook(webhookId) {
      calls.get.push(webhookId);
      const item = current.find((candidate) => candidate.id === webhookId);
      if (!item) throw new Error("not found");
      return item;
    },
  };
  return { calls, value };
}

test("disabled execution performs zero transport calls", async () => {
  const mocked = transport([snapshot()]);
  const result = await executeChannexChannelLifecycleWebhookRegistration({
    config: resolveOtaChannelLifecycleWebhookRegistrationConfig({}),
    transport: mocked.value,
  });
  assert.deepEqual(result, {
    status: "DISABLED",
    mode: "PLAN",
    reason: "DEFAULT_OFF",
  });
  assert.deepEqual(mocked.calls, { list: 0, put: [], get: [] });
});

test("PLAN identifies the existing updated_channel webhook and never mutates", async () => {
  const mocked = transport([
    snapshot({
      id: otherWebhookId,
      callbackUrl: "https://api-staging.example.com/webhooks/channex",
      eventMask: "booking",
      sendData: false,
    }),
    snapshot(),
  ]);
  const result = await executeChannexChannelLifecycleWebhookRegistration({
    config: config("PLAN"),
    transport: mocked.value,
  });
  assert.equal(result.status, "PLANNED");
  if (result.status !== "PLANNED") return;
  assert.equal(result.webhookId, webhookId);
  assert.equal(result.alreadyMatches, false);
  assert.deepEqual(result.changes, ["EVENT_MASK"]);
  assert.deepEqual(mocked.calls, { list: 1, put: [], get: [] });
  assert.doesNotMatch(JSON.stringify(result), /lifecycle-secret|api-key/);
});

test("APPLY performs exactly one PUT and one verification GET, without POST or DELETE capabilities", async () => {
  const mocked = transport([snapshot()]);
  const result = await executeChannexChannelLifecycleWebhookRegistration({
    config: config("APPLY"),
    transport: mocked.value,
  });

  assert.equal(result.status, "UPDATED_AND_VERIFIED");
  assert.equal(mocked.calls.list, 1);
  assert.equal(mocked.calls.put.length, 1);
  assert.deepEqual(mocked.calls.get, [webhookId]);
  assert.equal(mocked.calls.put[0]!.webhookId, webhookId);
  assert.equal(
    mocked.calls.put[0]!.payload.webhook.event_mask,
    OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK
  );
  assert.equal(mocked.calls.put[0]!.payload.webhook.send_data, true);
  assert.doesNotMatch(JSON.stringify(result), /lifecycle-secret|api-key/);
  assert.equal("postWebhook" in mocked.value, false);
  assert.equal("deleteWebhook" in mocked.value, false);
});

test("APPLY is idempotent: matching state skips PUT and still verifies with GET", async () => {
  const mocked = transport([
    snapshot({
      eventMask:
        "disconnect_listing;activate_channel;new_channel;disconnect_channel;updated_channel;deactivate_channel",
    }),
  ]);
  const result = await executeChannexChannelLifecycleWebhookRegistration({
    config: config("APPLY"),
    transport: mocked.value,
  });
  assert.equal(result.status, "UNCHANGED_AND_VERIFIED");
  assert.equal(mocked.calls.put.length, 0);
  assert.equal(mocked.calls.get.length, 1);
});

test("planner fails closed for zero, multiple, wildcard, mixed and protected candidates", () => {
  const args = {
    externalPropertyId,
    callbackUrl,
    webhookSecret,
  };
  const cases: Array<{
    webhooks: readonly ChannexWebhookSnapshot[];
    code: string;
  }> = [
    {
      webhooks: [
        snapshot({
          callbackUrl: "https://api-staging.example.com/webhooks/channex",
          eventMask: "booking",
        }),
      ],
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_CANDIDATE_NOT_FOUND",
    },
    {
      webhooks: [snapshot(), snapshot({ id: otherWebhookId })],
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_CANDIDATE_AMBIGUOUS",
    },
    {
      webhooks: [snapshot({ eventMask: "*" })],
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_WILDCARD_FORBIDDEN",
    },
    {
      webhooks: [snapshot({ eventMask: "updated_channel;booking" })],
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_MIXED",
    },
    {
      webhooks: [snapshot({ isProtected: true })],
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_PROTECTED",
    },
    {
      webhooks: [snapshot({ id: "webhook-opaque-id" })],
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_ID_INVALID",
    },
  ];

  for (const item of cases) {
    assert.throws(
      () =>
        planChannexChannelLifecycleWebhookRegistration({
          ...args,
          webhooks: item.webhooks,
        }),
      (error: unknown) =>
        error instanceof ChannexChannelLifecycleWebhookRegistrationError &&
        error.code === item.code
    );
  }

  assert.throws(
    () =>
      planChannexChannelLifecycleWebhookRegistration({
        ...args,
        externalPropertyId: "property-opaque-id",
        webhooks: [snapshot()],
      }),
    (error: unknown) =>
      error instanceof ChannexChannelLifecycleWebhookRegistrationError &&
      error.code === "OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID_REQUIRED"
  );
});

test("transport origin mismatch fails before list or mutation", async () => {
  const mocked = transport([snapshot()]);
  const mismatched = {
    ...mocked.value,
    apiOrigin: "https://app.channex.io",
  };
  await assert.rejects(
    executeChannexChannelLifecycleWebhookRegistration({
      config: config("PLAN"),
      transport: mismatched,
    }),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_TRANSPORT_ORIGIN_MISMATCH/
  );
  assert.deepEqual(mocked.calls, { list: 0, put: [], get: [] });
});

test("executor independently rejects an APPLY config without the exact authorization", async () => {
  const mocked = transport([snapshot()]);
  const unsafeConfig = {
    ...config("PLAN"),
    mode: "APPLY",
    applyConfirmation: "WRONG_CONFIRMATION",
  } as any;

  await assert.rejects(
    executeChannexChannelLifecycleWebhookRegistration({
      config: unsafeConfig,
      transport: mocked.value,
    }),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_APPLY_AUTHORIZATION_INVALID/
  );
  assert.deepEqual(mocked.calls, { list: 0, put: [], get: [] });
});

test("executor rejects callback origin drift before reads or secret-bearing writes", async () => {
  const mocked = transport([snapshot()]);
  const unsafePlan = {
    ...config("PLAN"),
    callbackUrl:
      "https://attacker.example/webhooks/ota/channex/channel-lifecycle",
  } as any;

  await assert.rejects(
    executeChannexChannelLifecycleWebhookRegistration({
      config: unsafePlan,
      transport: mocked.value,
    }),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_CALLBACK_ORIGIN_NOT_ALLOWED/
  );
  assert.deepEqual(mocked.calls, { list: 0, put: [], get: [] });

  const unsafeApply = {
    ...config("APPLY"),
    callbackUrl:
      "https://attacker.example/webhooks/ota/channex/channel-lifecycle",
    callbackAllowedOrigin: "https://attacker.example",
  } as any;
  await assert.rejects(
    executeChannexChannelLifecycleWebhookRegistration({
      config: unsafeApply,
      transport: mocked.value,
    }),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_APPLY_AUTHORIZATION_INVALID/
  );
  assert.deepEqual(mocked.calls, { list: 0, put: [], get: [] });
});

test("executor independently rejects every production-origin mode before reads", async () => {
  const mocked = transport([snapshot()]);
  const unsafePlan = {
    ...config("PLAN"),
    apiOrigin: "https://app.channex.io",
  } as any;
  const productionTransport = {
    ...mocked.value,
    apiOrigin: "https://app.channex.io",
  };

  await assert.rejects(
    executeChannexChannelLifecycleWebhookRegistration({
      config: unsafePlan,
      transport: productionTransport,
    }),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_STAGING_REQUIRED/
  );
  assert.deepEqual(mocked.calls, { list: 0, put: [], get: [] });
});

test("executor rejects a forged non-UUID property before reads", async () => {
  const mocked = transport([snapshot()]);
  const unsafePlan = {
    ...config("PLAN"),
    externalPropertyId: "property-opaque-id",
  } as any;

  await assert.rejects(
    executeChannexChannelLifecycleWebhookRegistration({
      config: unsafePlan,
      transport: mocked.value,
    }),
    /OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID_REQUIRED/
  );
  assert.deepEqual(mocked.calls, { list: 0, put: [], get: [] });
});

test("verification mismatch fails after the single PUT without retry or fallback mutation", async () => {
  const mocked = transport([snapshot()]);
  mocked.value.getWebhook = async (webhookId) => {
    mocked.calls.get.push(webhookId);
    return snapshot({
      id: webhookId,
      eventMask: OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
      headers: {
        [OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER]: "wrong-secret",
      },
    });
  };

  await assert.rejects(
    executeChannexChannelLifecycleWebhookRegistration({
      config: config("APPLY"),
      transport: mocked.value,
    }),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_SECRET_MISMATCH/
  );
  assert.equal(mocked.calls.put.length, 1);
  assert.equal(mocked.calls.get.length, 1);
});

test("verification rejects identity, scope, callback, mask and delivery mismatches", async () => {
  const cases: Array<{
    override: Partial<ChannexWebhookSnapshot>;
    code: string;
  }> = [
    {
      override: { id: "webhook-opaque-id" },
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_ID_INVALID",
    },
    {
      override: { id: otherWebhookId },
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_ID_MISMATCH",
    },
    {
      override: { propertyId: otherPropertyId },
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_SCOPE_MISMATCH",
    },
    {
      override: {
        callbackUrl:
          "https://other-staging.example.com/webhooks/ota/channex/channel-lifecycle",
      },
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_CALLBACK_MISMATCH",
    },
    {
      override: { eventMask: "updated_channel" },
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_EVENT_MASK_MISMATCH",
    },
    {
      override: { isActive: false },
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_INACTIVE",
    },
    {
      override: { sendData: false },
      code: "OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_SEND_DATA_DISABLED",
    },
  ];

  for (const item of cases) {
    const mocked = transport([snapshot()]);
    mocked.value.getWebhook = async (webhookId) => {
      mocked.calls.get.push(webhookId);
      return snapshot({
        id: webhookId,
        eventMask: OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
        ...item.override,
      });
    };
    await assert.rejects(
      executeChannexChannelLifecycleWebhookRegistration({
        config: config("APPLY"),
        transport: mocked.value,
      }),
      (error: unknown) =>
        error instanceof ChannexChannelLifecycleWebhookRegistrationError &&
        error.code === item.code
    );
    assert.equal(mocked.calls.put.length, 1);
    assert.equal(mocked.calls.get.length, 1);
  }
});
