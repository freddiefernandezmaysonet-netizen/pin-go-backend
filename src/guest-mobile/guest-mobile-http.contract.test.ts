import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const route = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");
const server = await fs.readFile(new URL("../server.ts", import.meta.url), "utf8");

test("exchange route exposes only the intended public contract", () => {
  assert.match(route, /"\/api\/guest-mobile\/session\/exchange"/);
  assert.match(route, /new Set\(\["guestToken", "deviceLabel", "platform"\]\)/);
  assert.doesNotMatch(route, /reservationId/);
  assert.doesNotMatch(route, /guestEmail|guestPhone|organizationId|propertyId/);
});

test("exchange response and transport are non-cacheable and identifier-minimal", () => {
  assert.match(route, /Cache-Control", "no-store"/);
  assert.match(route, /Referrer-Policy", "no-referrer"/);
  assert.match(route, /sessionToken: result\.bearer/);
  assert.match(route, /stay: result\.stay/);
  assert.doesNotMatch(route, /guestPersonId: result/);
  assert.doesNotMatch(route, /sessionId: result/);
});

test("public errors do not disclose token validity details", () => {
  assert.match(route, /STAY_NOT_AVAILABLE/);
  assert.doesNotMatch(route, /json\(\{ ok: false, error: code \}\)/);
});

test("guest mobile identity router is mounted by server", () => {
  assert.match(server, /guestMobileIdentityRouter/);
  assert.match(server, /app\.use\(guestMobileIdentityRouter\)/);
});
