import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type RequestHandler } from "express";

import { buildDashboardDistributionConnectionCenterRouter } from "./dashboard.distribution-connection-center.route";

type TestUser = { id: string; orgId: string };

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
}) {
  const app = express();
  if (args.user) {
    const injectUser: RequestHandler = (req, _res, next) => {
      (req as typeof req & { user: TestUser }).user = args.user!;
      next();
    };
    app.use(injectUser);
  }
  app.use(buildDashboardDistributionConnectionCenterRouter(args.prisma));

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;

  try {
    return await fetch(
      `http://127.0.0.1:${address.port}${
        args.path ?? "/api/dashboard/distribution/properties/property-b"
      }`,
      { method: args.method ?? "GET", headers: { Connection: "close" } }
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
