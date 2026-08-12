import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNEX_WEBHOOK_SECRET_HEADER,
  generateChannexWebhookSecret,
  readChannexWebhookSecret,
  verifyChannexWebhookSecret,
} from "./channex-webhook-auth";

test("generated Channex webhook secrets are high-entropy and URL-safe", () => {
  const first = generateChannexWebhookSecret();
  const second = generateChannexWebhookSecret();

  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
});

test("webhook secret is read from the fixed header", () => {
  assert.equal(
    readChannexWebhookSecret({
      [CHANNEX_WEBHOOK_SECRET_HEADER]: " secret-value ",
    }),
    "secret-value"
  );
});

test("valid webhook secret is accepted", () => {
  assert.equal(
    verifyChannexWebhookSecret({
      expectedSecret: "expected-secret",
      headers: {
        [CHANNEX_WEBHOOK_SECRET_HEADER]: "expected-secret",
      },
    }),
    true
  );
});

test("missing, different, or different-length webhook secrets are rejected", () => {
  assert.equal(
    verifyChannexWebhookSecret({
      expectedSecret: null,
      headers: {},
    }),
    false
  );

  assert.equal(
    verifyChannexWebhookSecret({
      expectedSecret: "expected-secret",
      headers: {
        [CHANNEX_WEBHOOK_SECRET_HEADER]: "wrong-secret",
      },
    }),
    false
  );

  assert.equal(
    verifyChannexWebhookSecret({
      expectedSecret: "expected-secret",
      headers: {
        [CHANNEX_WEBHOOK_SECRET_HEADER]: "short",
      },
    }),
    false
  );
});
