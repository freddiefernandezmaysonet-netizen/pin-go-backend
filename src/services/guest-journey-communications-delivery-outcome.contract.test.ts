import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveTwilioStatusCallback } from "../integrations/twilio/twilio.client";
import {
  __messageDeliveryWebhookInternals,
} from "../routes/message-delivery.webhooks.routes";

async function read(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("delivery webhooks are default-off and require explicit activation", () => {
  assert.equal(
    __messageDeliveryWebhookInternals.deliveryWebhooksEnabled({}),
    false
  );

  assert.equal(
    __messageDeliveryWebhookInternals.deliveryWebhooksEnabled({
      MESSAGE_DELIVERY_WEBHOOKS_ENABLED: "1",
    } as NodeJS.ProcessEnv),
    true
  );
});

test("Twilio status callback is only attached with secure complete configuration", () => {
  assert.equal(resolveTwilioStatusCallback({} as NodeJS.ProcessEnv), null);

  assert.equal(
    resolveTwilioStatusCallback({
      MESSAGE_DELIVERY_WEBHOOKS_ENABLED: "1",
      TWILIO_AUTH_TOKEN: "secret",
      PUBLIC_API_BASE_URL: "https://api.pin-ngo.com",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv),
    "https://api.pin-ngo.com/webhooks/delivery/twilio"
  );

  assert.equal(
    resolveTwilioStatusCallback({
      MESSAGE_DELIVERY_WEBHOOKS_ENABLED: "1",
      TWILIO_AUTH_TOKEN: "secret",
      PUBLIC_API_BASE_URL: "http://api.pin-ngo.com",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv),
    null
  );

  assert.equal(
    resolveTwilioStatusCallback({
      MESSAGE_DELIVERY_WEBHOOKS_ENABLED: "1",
      TWILIO_AUTH_TOKEN: "secret",
      PUBLIC_BASE_URL: "https://api.pin-ngo.com",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv),
    "https://api.pin-ngo.com/webhooks/delivery/twilio"
  );
});

test("provider webhook routes verify signatures before persisting outcomes", async () => {
  const source = await read("../routes/message-delivery.webhooks.routes.ts");

  assert.match(source, /verifyResendWebhookSignature\(/);
  assert.match(source, /payload:\s*rawBody/);
  assert.match(source, /secret:\s*webhookSecret/);
  assert.match(source, /id:\s*svixId/);
  assert.match(source, /timestamp:\s*svixTimestamp/);
  assert.match(source, /signature:\s*svixSignature/);
  assert.doesNotMatch(source, /new Resend|resend\.webhooks\.verify|resend as any/);
  assert.match(source, /JSON\.parse\(rawBody\)/);
  assert.match(source, /Twilio\.validateRequest\(/);
  assert.match(source, /x-twilio-signature/);
  assert.match(source, /recordMessageDeliveryOutcome\(/);

  const resendVerifyIndex = source.indexOf("webhooks.verify");
  const resendPersistIndex = source.indexOf(
    "recordMessageDeliveryOutcome",
    resendVerifyIndex
  );
  assert.ok(resendVerifyIndex >= 0);
  assert.ok(resendPersistIndex > resendVerifyIndex);

  const twilioVerifyIndex = source.indexOf("Twilio.validateRequest");
  const twilioPersistIndex = source.indexOf(
    "recordMessageDeliveryOutcome",
    twilioVerifyIndex
  );
  assert.ok(twilioVerifyIndex >= 0);
  assert.ok(twilioPersistIndex > twilioVerifyIndex);
});

test("server captures raw JSON and form data before mounting delivery webhooks", async () => {
  const server = await read("../server.ts");

  const jsonIndex = server.indexOf("express.json");
  const urlencodedIndex = server.indexOf("bodyParser.urlencoded");
  const routerIndex = server.indexOf(
    "buildMessageDeliveryWebhookRouter(prisma)"
  );

  assert.ok(jsonIndex >= 0);
  assert.ok(urlencodedIndex >= 0);
  assert.ok(routerIndex >= 0);
  assert.ok(jsonIndex < routerIndex);
  assert.ok(urlencodedIndex < routerIndex);
  assert.match(server, /req\.rawBody = buf/);
});

test("MessageLog delivery outcome fields are additive and do not replace status", async () => {
  const schema = await read("../../prisma/schema.prisma");
  const migration = await read(
    "../../prisma/migrations/20260926174500_add_message_delivery_outcomes_v1/migration.sql"
  );

  assert.match(schema, /providerDeliveryStatus\s+String\?/);
  assert.match(schema, /providerStatusUpdatedAt\s+DateTime\?/);
  assert.match(schema, /providerErrorCode\s+String\?/);
  assert.match(schema, /providerErrorMessage\s+String\?/);
  assert.match(schema, /deliveredAt\s+DateTime\?/);
  assert.match(
    schema,
    /@@index\(\[provider, providerMessageId\]\)/
  );

  assert.match(
    migration,
    /ADD COLUMN "providerDeliveryStatus" TEXT/
  );
  assert.match(
    migration,
    /ADD COLUMN "deliveredAt" TIMESTAMP\(3\)/
  );
  assert.doesNotMatch(
    migration,
    /DROP COLUMN "status"|ALTER COLUMN "status"/
  );
});
