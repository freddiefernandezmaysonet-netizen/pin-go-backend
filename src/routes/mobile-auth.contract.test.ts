import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const authRoutes = await fs.readFile(new URL("./auth.routes.ts", import.meta.url), "utf8");
const mfaRoutes = await fs.readFile(new URL("../auth/mfa-login.routes.ts", import.meta.url), "utf8");

test("mobile auth token is gated behind explicit mobile client marker", () => {
  for (const source of [authRoutes, mfaRoutes]) {
    assert.match(source, /x-pin-go-client/);
    assert.match(source, /=== "mobile"/);
    assert.match(source, /isMobileAuthClient\(req\) \? \{ mobileSessionToken: token \} : \{\}/);
  }
});

test("web auth cookie behavior remains present for login and MFA", () => {
  assert.match(authRoutes, /Set-Cookie/);
  assert.match(authRoutes, /buildAuthCookie\(token/);
  assert.match(mfaRoutes, /Set-Cookie/);
  assert.match(mfaRoutes, /buildAuthCookie\(token/);
});

test("mobile contract reuses the same session-bound token as web", () => {
  assert.match(authRoutes, /signSessionBoundAuthToken/);
  assert.match(mfaRoutes, /signSessionBoundAuthToken/);
  assert.doesNotMatch(authRoutes, /signMobile|MOBILE_JWT_SECRET/);
  assert.doesNotMatch(mfaRoutes, /signMobile|MOBILE_JWT_SECRET/);
});
