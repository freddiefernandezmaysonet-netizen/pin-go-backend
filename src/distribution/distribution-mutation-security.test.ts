import assert from "node:assert/strict";
import test from "node:test";
import { createDistributionMutationSecurity } from "./distribution-mutation-security.js";

async function callSecurity(args: {
  role?: string;
  origin?: string;
  requestKey?: string;
  trusted?: boolean;
}) {
  const middleware = createDistributionMutationSecurity({
    isTrustedOrigin: async () => args.trusted ?? true,
  });
  const req = {
    user: { id: "user-1", orgId: "org-1", role: args.role },
    get(name: string) {
      if (name === "origin") return args.origin;
      if (name === "idempotency-key") return args.requestKey;
      return undefined;
    },
  } as any;
  let status = 200;
  let body: any;
  let continued = false;
  const res = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; },
  } as any;
  await middleware(req, res, () => { continued = true; });
  return { status, body, continued, requestKey: req.distributionRequestKey };
}

test("only administrative tenant roles can mutate distribution", async () => {
  const result = await callSecurity({
    role: "MEMBER",
    origin: "https://app.pin-go.test",
    requestKey: "request-123",
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "OTA_CONNECTION_MUTATION_FORBIDDEN");
  assert.equal(result.continued, false);
});

test("trusted origin and a valid idempotency key are mandatory", async () => {
  const missingOrigin = await callSecurity({ role: "ORG_ADMIN", requestKey: "request-123" });
  assert.equal(missingOrigin.body.error, "OTA_CONNECTION_ORIGIN_REQUIRED");

  const untrusted = await callSecurity({
    role: "ORG_ADMIN",
    origin: "https://evil.example",
    requestKey: "request-123",
    trusted: false,
  });
  assert.equal(untrusted.body.error, "OTA_CONNECTION_ORIGIN_NOT_ALLOWED");

  const invalidKey = await callSecurity({
    role: "ORG_ADMIN",
    origin: "https://app.pin-go.test",
    requestKey: "short",
  });
  assert.equal(invalidKey.status, 400);
  assert.equal(invalidKey.body.error, "OTA_CONNECTION_IDEMPOTENCY_KEY_INVALID");
});

test("validated request key is passed to the mutation handler", async () => {
  const result = await callSecurity({
    role: "PLATFORM_ADMIN",
    origin: "https://app.pin-go.test/path",
    requestKey: "ota.session:1234",
  });
  assert.equal(result.continued, true);
  assert.equal(result.requestKey, "ota.session:1234");
});
