import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual Express login handler with synthetic persistence and crypto
// boundaries. No production database, credentials, email or sockets are used.
test("review login keeps password checks and ordinary MFA, and fails closed", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const nativeRequire = createRequire(import.meta.url);
  const users = [
    { id: "review", organizationId: "review-org", email: "apple-review@pin-ngo.com", role: "ORG_ADMIN", isActive: true, tokenVersion: 1, passwordHash: "synthetic", organization: { name: "Pin&Go App Review", slug: "pin-go-app-review" } },
    { id: "normal", organizationId: "normal-org", email: "host@example.invalid", role: "ORG_ADMIN", isActive: true, tokenVersion: 1, passwordHash: "synthetic", organization: { name: "Normal", slug: "normal" } },
  ];
  const env: Record<string, string> = { PINGO_APP_REVIEW_ENABLED: "true", PINGO_SESSION_MODE: "ENFORCE",
    PINGO_APP_REVIEW_USER_ID: "review", PINGO_APP_REVIEW_ORGANIZATION_ID: "review-org",
    PINGO_APP_REVIEW_EXPIRES_AT: new Date(Date.now() + 86400000).toISOString() };
  const sessions: any[] = []; const events: any[] = []; let challenges = 0; let isolated = true; let auditFails = false;
  const db: any = {
    dashboardUser: { findUnique: async ({ where }: any) => users.find(u => u.email === where.email), update: async () => ({}) },
    organization: { findFirst: async () => isolated ? { id: "review-org" } : null },
    authSession: { create: async ({ data }: any) => { const row = { ...data, id: `session-${sessions.length}` }; sessions.push(row); return row; } },
    securityEvent: { create: async ({ data }: any) => { if (auditFails) throw Error("audit unavailable"); events.push(data); return data; } },
    $transaction: async (fn: any) => fn(db),
  };
  const cache = new Map<string, any>();
  const noop = (_req: any, _res: any, next: any) => next?.();
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const require = (name: string): any => {
      if (name === "express" || name.startsWith("node:")) return nativeRequire(name);
      if (name === "@prisma/client") return { PrismaClient: class { constructor() { return db; } } };
      const stem = resolve(dirname(file), name).replace(/\.(js|ts)$/, "");
      if (stem.endsWith("/lib/auth")) return { comparePassword: async (p: string) => p === "synthetic-password", buildAuthCookie: () => "auth=synthetic", buildClearAuthCookie: () => "", extractTokenFromRequest: () => null, hashPassword: async () => "" };
      if (stem.endsWith("/lib/passwordPolicy")) return { validatePasswordPolicy: () => ({ ok: true }) };
      if (stem.endsWith("/controllers/password.controller")) return { forgotPasswordHandler: noop, verifyForgotPasswordCodeHandler: noop, resetPasswordHandler: noop };
      if (stem.endsWith("/middleware/requireAuth")) return { requireAuth: noop };
      if (stem.endsWith("/auth/mfa-login.routes")) return { mfaLoginRouter: nativeRequire("express").Router() };
      if (stem.endsWith("/auth/mfa-global-runtime")) return { evaluateE7EffectiveMode: () => ({ mode: "ENFORCE", ready: true, failClosed: true }), requiresE7MfaChallenge: () => true };
      if (stem.endsWith("/auth/mfa-login-runtime")) return { observeE5ShadowLogin: () => { throw Error("unexpected shadow"); } };
      if (stem.endsWith("/auth/mfa-canary-runtime")) return { findValidE6TrustedDevice: async () => null };
      if (stem.endsWith("/auth/mfa-canary-flow")) return { beginE6EmailCanary: async () => { challenges++; return { challengeToken: "synthetic", maskedDestination: "h***", expiresAt: new Date(Date.now() + 60000) }; } };
      if (stem.endsWith("/auth/session-bound-token")) return { signSessionBoundAuthToken: (_p: any, id: string, policy: string) => `${id}:${policy}`, verifySessionBoundAuthToken: () => ({}) };
      if (stem.endsWith("/auth/session-binding-shadow")) return { revokeBoundSessionOnLogout: noop };
      if (stem.endsWith("/auth/session-enforcement-runtime")) return { touchBoundSessionHumanActivity: noop };
      return load(stem + ".ts");
    };
    const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require, process: { env }, console: { error: noop }, Date, Buffer }, { filename: file });
    return module.exports;
  }
  const router = load(resolve(root, "routes/auth.routes.ts")).authRouter;
  const handler = router.stack.find((layer: any) => layer.route?.path === "/auth/login").route.stack[0].handle;
  async function login(email = users[0]!.email, password = "synthetic-password") {
    const result = { status: 200, body: {} as any, cookie: "" };
    const res: any = { status: (s: number) => { result.status = s; return res; }, json: (b: any) => { result.body = b; return res; }, setHeader: (name: string, value: string) => { if (name === "Set-Cookie") result.cookie = value; } };
    await handler({ body: { email, password }, headers: {}, get: (name: string) => name === "x-pin-go-client" ? "mobile" : name === "x-pin-go-session-renewal" ? "1" : undefined }, res);
    return result;
  }
  assert.equal((await login(undefined, "wrong-password")).status, 401);
  assert.equal(sessions.length, 0); assert.equal(challenges, 0);
  const review = await login();
  assert.equal(review.status, 200); assert.equal(review.body.mfaRequired, undefined);
  assert.match(review.body.mobileSessionToken, /:LEGACY$/); assert.equal(events.length, 1);
  assert.equal(challenges, 0);
  assert.equal((await login(users[1]!.email)).body.mfaRequired, true);
  env.PINGO_APP_REVIEW_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  assert.equal((await login()).body.mfaRequired, true);
  env.PINGO_APP_REVIEW_EXPIRES_AT = new Date(Date.now() + 86400000).toISOString();
  isolated = false;
  assert.equal((await login()).status, 500);
  isolated = true; auditFails = true;
  const failed = await login(); assert.equal(failed.status, 500); assert.equal(failed.cookie, "");
  users[0]!.isActive = false;
  assert.equal((await login()).status, 403);
});
