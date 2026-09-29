import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./ttlock-mobile-access-provider.ts", import.meta.url), "utf8");
const routes = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");

test("TTLock send uses organization owner token and disables remote unlock", () => {
  assert.match(source, /getOrgTtlockAccessToken\(this\.prisma, this\.organizationId\)/);
  assert.match(source, /\/v3\/key\/send/);
  assert.match(source, /remoteEnable: 2/);
  assert.match(source, /createUser: 0/);
});

test("key detail uses recipient token, not owner token", () => {
  const getAt = source.indexOf("/v3/key/get");
  assert.ok(getAt >= 0);
  const block = source.slice(Math.max(0, getAt - 500), getAt + 500);
  assert.match(block, /recipientAccessToken/);
  assert.doesNotMatch(block, /ownerAccessToken/);
});

test("recipient access token refresh uses encrypted refresh token and persists only ciphertext", () => {
  assert.match(source, /grant_type: "refresh_token"/);
  assert.match(source, /decryptMobileAccessSecret\(identity\.refreshTokenCiphertext/);
  assert.match(source, /encryptMobileAccessSecret\(accessToken/);
  assert.match(source, /encryptMobileAccessSecret\(nextRefreshToken/);
  assert.doesNotMatch(source, /data:\s*\{[^}]*accessToken:\s*accessToken/s);
});

test("provider remains disconnected from guest routes and reservation worker", () => {
  assert.doesNotMatch(routes, /TTLockMobileAccessProvider|provisionMobileAccessCredential/);
  assert.doesNotMatch(worker, /TTLockMobileAccessProvider|provisionMobileAccessCredential/);
});
