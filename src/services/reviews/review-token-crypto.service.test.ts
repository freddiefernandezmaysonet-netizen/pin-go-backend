import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, test } from "node:test";
import { assertReviewTokenEncryptionConfigured, decryptReviewToken, encryptReviewToken } from "./review-token-crypto.service.js";

const originalKey = process.env.REVIEW_TOKEN_ENC_KEY_BASE64;
const originalKeyring = process.env.REVIEW_TOKEN_ENC_KEYRING_JSON;
const originalActiveKid = process.env.REVIEW_TOKEN_ENC_ACTIVE_KID;

afterEach(() => {
  if (originalKey === undefined) delete process.env.REVIEW_TOKEN_ENC_KEY_BASE64;
  else process.env.REVIEW_TOKEN_ENC_KEY_BASE64 = originalKey;
  if (originalKeyring === undefined) delete process.env.REVIEW_TOKEN_ENC_KEYRING_JSON;
  else process.env.REVIEW_TOKEN_ENC_KEYRING_JSON = originalKeyring;
  if (originalActiveKid === undefined) delete process.env.REVIEW_TOKEN_ENC_ACTIVE_KID;
  else process.env.REVIEW_TOKEN_ENC_ACTIVE_KID = originalActiveKid;
});

test("encrypts review tokens with authenticated randomized ciphertext", () => {
  delete process.env.REVIEW_TOKEN_ENC_KEYRING_JSON;
  delete process.env.REVIEW_TOKEN_ENC_ACTIVE_KID;
  process.env.REVIEW_TOKEN_ENC_KEY_BASE64 = crypto.randomBytes(32).toString("base64");
  const token = "review-token-that-must-never-be-persisted-in-plaintext";

  const first = encryptReviewToken(token);
  const second = encryptReviewToken(token);

  assert.notEqual(first, token);
  assert.notEqual(first, second);
  assert.match(first, /^v1\.[A-Za-z0-9_-]+$/);
  assert.equal(decryptReviewToken(first), token);
  assert.equal(decryptReviewToken(second), token);
});

test("rejects tampered ciphertext and invalid encryption configuration", () => {
  delete process.env.REVIEW_TOKEN_ENC_KEYRING_JSON;
  delete process.env.REVIEW_TOKEN_ENC_ACTIVE_KID;
  process.env.REVIEW_TOKEN_ENC_KEY_BASE64 = crypto.randomBytes(32).toString("base64");
  const [kid, encoded] = encryptReviewToken("a-stable-review-token-value").split(".");
  const encrypted = Buffer.from(encoded, "base64url");
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptReviewToken(`${kid}.${encrypted.toString("base64url")}`));

  process.env.REVIEW_TOKEN_ENC_KEY_BASE64 = Buffer.alloc(16).toString("base64");
  assert.throws(() => assertReviewTokenEncryptionConfigured(), /exactly 32 bytes/);

  delete process.env.REVIEW_TOKEN_ENC_KEY_BASE64;
  assert.throws(() => assertReviewTokenEncryptionConfigured(), /Missing REVIEW_TOKEN_ENC_KEY_BASE64 or REVIEW_TOKEN_ENC_KEYRING_JSON/);
});

test("decrypts active invitations while rotating to a new key id", () => {
  const v1 = crypto.randomBytes(32).toString("base64");
  const v2 = crypto.randomBytes(32).toString("base64");
  delete process.env.REVIEW_TOKEN_ENC_KEY_BASE64;
  process.env.REVIEW_TOKEN_ENC_KEYRING_JSON = JSON.stringify({ v1, v2 });
  process.env.REVIEW_TOKEN_ENC_ACTIVE_KID = "v1";
  const oldCiphertext = encryptReviewToken("old-active-link");

  process.env.REVIEW_TOKEN_ENC_ACTIVE_KID = "v2";
  const newCiphertext = encryptReviewToken("new-active-link");
  assert.match(oldCiphertext, /^v1\./);
  assert.match(newCiphertext, /^v2\./);
  assert.equal(decryptReviewToken(oldCiphertext), "old-active-link");
  assert.equal(decryptReviewToken(newCiphertext), "new-active-link");

  process.env.REVIEW_TOKEN_ENC_KEYRING_JSON = JSON.stringify({ v2 });
  assert.throws(() => decryptReviewToken(oldCiphertext), /Unknown review token encryption key id/);
});
