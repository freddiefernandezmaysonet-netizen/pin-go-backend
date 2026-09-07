import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type RequestHandler } from "express";

import { buildDashboardDistributionConnectionCenterRouter } from "./dashboard.distribution-connection-center.route";

type TestUser = { id: string; orgId: string; role?: string };

function createPrisma(overrides: Record<string, unknown> = {}) {
  return {
    property: { findFirst: async () => null },
    distributionProperty: { findFirst: async () => null },
    ...overrides,
  } as any;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function requestRoute(args: {
  prisma: any;
  user?: TestUser;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  actions?: Parameters<typeof buildDashboardDistributionConnectionCenterRouter>[1];
}) {
  const app = express();
  if (args.user) {
    const injectUser: RequestHandler = (req, _res, next) => {
      (req as typeof req & { user: TestUser }).user = args.user!;
      next();
    };
    app.use(injectUser);
  }
  app.use(express.json());
  app.use(buildDashboardDistributionConnectionCenterRouter(args.prisma, args.actions));

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;

  try {
    return await fetch(
      `http://127.0.0.1:${address.port}${
        args.path ?? "/api/dashboard/distribution/properties/property-b"
      }`,
      {
        method: args.method ?? "GET",
        headers: { Connection: "close", ...args.headers },
      }
    );
  } finally {
    await closeServer(server);
  }
}

test("legacy mutation endpoints are fenced before database or vendor access", async () => {
  let reads = 0;
  const prisma = createPrisma({
    property: {
      findFirst: async () => {
        reads += 1;
        return null;
      },
    },
  });

  for (const path of [
    "/api/dashboard/properties/property-b/distribution/enable",
    "/api/dashboard/properties/property-b/channex/provision",
    "/api/dashboard/properties/property-b/channex/sync-availability",
  ]) {
    const response = await requestRoute({
      prisma,
      user: { id: "user-a", orgId: "organization-a" },
      method: "POST",
      path,
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "OTA_DISTRIBUTION_CONNECTION_CENTER_REQUIRED",
    });
  }

  assert.equal(reads, 0);
});

test("unauthenticated callers are rejected before property data is read", async () => {
  let propertyReads = 0;
  const response = await requestRoute({
    prisma: createPrisma({
      property: {
        findFirst: async () => {
          propertyReads += 1;
          return null;
        },
      },
    }),
  });

  assert.equal(response.status, 401);
  assert.equal(propertyReads, 0);
});

test("property lookup is scoped to the authenticated tenant", async () => {
  let propertyQuery: any;
  let distributionReads = 0;
  const response = await requestRoute({
    user: { id: "user-a", orgId: "organization-a" },
    prisma: createPrisma({
      property: {
        findFirst: async (args: any) => {
          propertyQuery = args;
          return null;
        },
      },
      distributionProperty: {
        findFirst: async () => {
          distributionReads += 1;
          return null;
        },
      },
    }),
  });

  assert.equal(response.status, 404);
  assert.deepEqual(propertyQuery.where, {
    id: "property-b",
    organizationId: "organization-a",
    status: "ACTIVE",
  });
  assert.equal(distributionReads, 0);
});

test("distribution records and channel rows are checked against tenant scope", async () => {
  const response = await requestRoute({
    user: { id: "user-a", orgId: "organization-a" },
    prisma: createPrisma({
      property: {
        findFirst: async () => ({ id: "property-b", name: "Casa B" }),
      },
      distributionProperty: {
        findFirst: async () => ({
          organizationId: "organization-a",
          provisioningStatus: "READY",
          otaChannelConnections: [
            { organizationId: "organization-other", propertyId: "property-b" },
          ],
        }),
      },
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "OTA_DISTRIBUTION_TENANT_MISMATCH",
  });
});

test("successful response is no-store and does not expose the distribution vendor", async () => {
  let distributionQuery: any;
  const response = await requestRoute({
    user: { id: "user-a", orgId: "organization-a" },
    prisma: createPrisma({
      property: {
        findFirst: async () => ({ id: "property-b", name: "Casa B" }),
      },
      distributionProperty: {
        findFirst: async (args: any) => {
          distributionQuery = args;
          return null;
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(distributionQuery.where, {
    propertyId: "property-b",
    organizationId: "organization-a",
    platform: "CHANNEX",
  });
  const body = await response.text();
  assert.equal(body.toLowerCase().includes("channex"), false);
  assert.equal(JSON.parse(body).connectionCenter.status, "NOT_CONFIGURED");
});

test("new mutation routes are default-off before database or adapter work", async () => {
  let calls = 0;
  const response = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/prepare",
    headers: {
      Origin: "https://app.pin-go.test",
      "Idempotency-Key": "prepare-request-123",
    },
    actions: {
      runtime: { enabled: false, reason: "DEFAULT_OFF" },
      isTrustedOrigin: async () => true,
      prepare: async () => { calls += 1; return { provisioningStatus: "READY" }; },
    },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls, 0);
});

test("member, origin and idempotency fences run before mutation action", async () => {
  let calls = 0;
  const baseActions = {
    runtime: { enabled: true, reason: "ENABLED" as const },
    isTrustedOrigin: async (origin: string) => origin === "https://app.pin-go.test",
    prepare: async () => { calls += 1; return { provisioningStatus: "READY" }; },
  };
  const member = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "MEMBER" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/prepare",
    headers: { Origin: "https://app.pin-go.test", "Idempotency-Key": "request-123" },
    actions: baseActions,
  });
  assert.equal(member.status, 403);

  const missingKey = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/prepare",
    headers: { Origin: "https://app.pin-go.test" },
    actions: baseActions,
  });
  assert.equal(missingKey.status, 400);
  assert.equal(calls, 0);
});

test("tenant actor and request key are forwarded to injected orchestration", async () => {
  let received: any;
  const response = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/BOOKING_COM/prepare",
    headers: { Origin: "https://app.pin-go.test", "Idempotency-Key": "request-tenant-123" },
    actions: {
      runtime: { enabled: true, reason: "ENABLED" },
      isTrustedOrigin: async (_origin, organizationId) => organizationId === "organization-a",
      prepare: async (args) => { received = args; return { provisioningStatus: "READY" }; },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    organizationId: "organization-a",
    propertyId: "property-b",
    requestedByUserId: "user-a",
    provider: "BOOKING_COM",
    requestKey: "request-tenant-123",
  });
});

test("session response exposes the launch URL but not a duplicate raw token", async () => {
  const response = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/session",
    headers: {
      Origin: "https://app.pin-go.test",
      "Idempotency-Key": "session-request-123",
    },
    actions: {
      runtime: { enabled: true, reason: "ENABLED" },
      isTrustedOrigin: async () => true,
      issueSession: async () => ({
        sessionId: "session-1",
        token: "raw-one-time-token",
        launchUrl: "https://staging.channex.io/channels?one_time_token=opaque",
        expiresAt: new Date("2026-09-06T12:00:00.000Z"),
      }),
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.deepEqual(body, {
    ok: true,
    session: {
      sessionId: "session-1",
      launchUrl: "https://staging.channex.io/channels?one_time_token=opaque",
      expiresAt: "2026-09-06T12:00:00.000Z",
    },
  });
  assert.equal(JSON.stringify(body).includes("raw-one-time-token"), false);
});

test("reconcile is default-off and does not call the reconciler", async () => {
  let calls = 0;
  const response = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/reconcile",
    headers: { Origin: "https://app.pin-go.test", "Idempotency-Key": "reconcile-off-123" },
    actions: {
      runtime: { enabled: false, reason: "DEFAULT_OFF" },
      isTrustedOrigin: async () => true,
      reconcile: async () => {
        calls += 1;
        return {
          authorizationReadiness: "READY",
          mappingReadiness: "READY",
          distributionReadiness: "READY",
          reasons: [],
        };
      },
    },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls, 0);
});

test("reconcile requires ORG_ADMIN and an idempotency key", async () => {
  let calls = 0;
  const actions = {
    runtime: { enabled: true, reason: "ENABLED" as const },
    isTrustedOrigin: async () => true,
    reconcile: async () => {
      calls += 1;
      return {
        authorizationReadiness: "READY" as const,
        mappingReadiness: "READY" as const,
        distributionReadiness: "READY" as const,
        reasons: [],
      };
    },
  };
  const member = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "MEMBER" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/reconcile",
    headers: { Origin: "https://app.pin-go.test", "Idempotency-Key": "reconcile-member-123" },
    actions,
  });
  assert.equal(member.status, 403);

  const noKey = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/reconcile",
    headers: { Origin: "https://app.pin-go.test" },
    actions,
  });
  assert.equal(noKey.status, 400);
  assert.equal(calls, 0);
});

test("reconcile forwards tenant, property, provider and request key", async () => {
  let received: any;
  const response = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/reconcile",
    headers: { Origin: "https://app.pin-go.test", "Idempotency-Key": "reconcile-tenant-123" },
    actions: {
      runtime: { enabled: true, reason: "ENABLED" },
      isTrustedOrigin: async (_origin, organizationId) => organizationId === "organization-a",
      reconcile: async (args) => {
        received = args;
        return {
          authorizationReadiness: "READY",
          mappingReadiness: "READY",
          distributionReadiness: "IN_PROGRESS",
          reasons: ["AWAITING_ACTIVATION_EVIDENCE"],
        };
      },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    organizationId: "organization-a",
    propertyId: "property-b",
    requestedByUserId: "user-a",
    provider: "AIRBNB",
    requestKey: "reconcile-tenant-123",
  });
  assert.deepEqual(await response.json(), {
    ok: true,
    readiness: {
      authorizationReadiness: "READY",
      mappingReadiness: "READY",
      distributionReadiness: "IN_PROGRESS",
      reasons: ["AWAITING_ACTIVATION_EVIDENCE"],
    },
  });
});

test("reconcile response exposes readiness only and does not leak provider evidence", async () => {
  const response = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/reconcile",
    headers: { Origin: "https://app.pin-go.test", "Idempotency-Key": "reconcile-safe-response" },
    actions: {
      runtime: { enabled: true, reason: "ENABLED" },
      isTrustedOrigin: async () => true,
      reconcile: async () => ({
        authorizationReadiness: "READY",
        mappingReadiness: "READY",
        distributionReadiness: "READY",
        reasons: [],
      }),
    },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes("user-api-key"), false);
  assert.equal(body.includes("staging.channex.io"), false);
  assert.equal(body.includes("externalConnectionId"), false);
  assert.equal(body.includes("payload"), false);
});

test("reconcile conflict fails closed without internal detail leakage", async () => {
  const response = await requestRoute({
    prisma: createPrisma(),
    user: { id: "user-a", orgId: "organization-a", role: "ORG_ADMIN" },
    method: "POST",
    path: "/api/dashboard/distribution/properties/property-b/channels/AIRBNB/reconcile",
    headers: { Origin: "https://app.pin-go.test", "Idempotency-Key": "reconcile-conflict-123" },
    actions: {
      runtime: { enabled: true, reason: "ENABLED" },
      isTrustedOrigin: async () => true,
      reconcile: async () => {
        const error = new Error("database row detail must not leak") as Error & { code: string };
        error.code = "OTA_CANONICAL_READINESS_STATE_CONFLICT";
        throw error;
      },
    },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "OTA_CANONICAL_READINESS_STATE_CONFLICT",
  });
});
