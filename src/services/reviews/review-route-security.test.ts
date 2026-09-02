import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { NextFunction, Request, Response } from "express";
import {
  createReviewRateLimit,
  requireTrustedReviewMutationOrigin,
  reviewTokenFromRequest,
} from "./review-route-security.js";
import { getAuthCookieName } from "../../lib/auth.js";

const originalFrontendOrigin = process.env.FRONTEND_ORIGIN;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalFrontendOrigin === undefined) delete process.env.FRONTEND_ORIGIN;
  else process.env.FRONTEND_ORIGIN = originalFrontendOrigin;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

function request(headers: Record<string, string> = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ip: "203.0.113.10",
    socket: { remoteAddress: "203.0.113.10" },
    params: {},
    user: { id: "user-1", orgId: "org-1" },
    get(name: string) { return normalized[name.toLowerCase()]; },
  } as unknown as Request;
}

function response() {
  const state = { status: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    setHeader(name: string, value: string) { state.headers[name] = value; },
    status(value: number) { state.status = value; return res; },
    json(value: unknown) { state.body = value; return res; },
  } as unknown as Response;
  return { res, state };
}

test("rate limiter blocks requests beyond its bounded window", () => {
  const limiter = createReviewRateLimit({
    namespace: `test-${Date.now()}-${Math.random()}`,
    windowMs: 60_000,
    max: 2,
    key: () => "same-client",
  });
  let nextCalls = 0;
  const next = (() => { nextCalls += 1; }) as NextFunction;
  const first = response();
  const second = response();
  const third = response();

  limiter(request(), first.res, next);
  limiter(request(), second.res, next);
  limiter(request(), third.res, next);

  assert.equal(nextCalls, 2);
  assert.equal(third.state.status, 429);
  assert.deepEqual(third.state.body, {
    ok: false,
    error: "REVIEW_RATE_LIMITED",
    retryAfterSeconds: 60,
  });
  assert.equal(third.state.headers["Retry-After"], "60");
});

test("cookie mutations require a trusted origin and cannot use a dummy bearer bypass", async () => {
  process.env.FRONTEND_ORIGIN = "https://app.pin-ngo.com";
  const cookie = `${getAuthCookieName()}=session-value`;
  let nextCalls = 0;
  const next = (() => { nextCalls += 1; }) as NextFunction;

  const allowed = response();
  await requireTrustedReviewMutationOrigin(
    request({ cookie, origin: "https://app.pin-ngo.com" }),
    allowed.res,
    next
  );
  assert.equal(nextCalls, 1);

  const missing = response();
  await requireTrustedReviewMutationOrigin(
    request({ cookie, authorization: "Bearer attacker-controlled" }),
    missing.res,
    next
  );
  assert.equal(nextCalls, 1);
  assert.equal(missing.state.status, 403);
  assert.deepEqual(missing.state.body, {
    ok: false,
    error: "REVIEW_ORIGIN_REQUIRED",
  });
});

test("production review mutations never trust localhost origins", async () => {
  process.env.NODE_ENV = "production";
  process.env.FRONTEND_ORIGIN = "https://app.pin-ngo.com";
  const cookie = `${getAuthCookieName()}=session-value`;
  let nextCalls = 0;
  const next = (() => { nextCalls += 1; }) as NextFunction;

  for (const origin of ["http://localhost:5173", "http://127.0.0.1:4173"]) {
    const blocked = response();
    await requireTrustedReviewMutationOrigin(
      request({ cookie, origin }),
      blocked.res,
      next
    );
    assert.equal(blocked.state.status, 403);
    assert.deepEqual(blocked.state.body, {
      ok: false,
      error: "REVIEW_ORIGIN_REQUIRED",
    });
  }

  assert.equal(nextCalls, 0);
});

test("review secrets use the dedicated authorization scheme", () => {
  const token = "A".repeat(43);
  assert.equal(
    reviewTokenFromRequest(request({ authorization: `ReviewToken ${token}` })),
    token
  );
  assert.equal(
    reviewTokenFromRequest(request({ authorization: `Bearer ${token}` })),
    ""
  );
});
