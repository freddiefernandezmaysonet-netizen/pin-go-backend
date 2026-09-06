import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type RequestHandler } from "express";

import { buildListingsMappingRouter } from "./listings.mapping.routes";

type TestUser = { id: string; orgId: string };

function createPrisma(overrides: Record<string, unknown> = {}) {
  return {
    pmsConnection: {
      findFirst: async () => null,
    },
    pmsListing: {
      findFirst: async () => null,
      findMany: async () => [],
      findUnique: async () => null,
      updateMany: async () => ({ count: 0 }),
      create: async () => null,
    },
    property: {
      findFirst: async () => null,
    },
    webhookEventIngest: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
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
  path: string;
  method?: string;
  body?: unknown;
  user?: TestUser;
  nodeEnv?: string;
}) {
  const app = express();
  app.use(express.json());

  if (args.user) {
    const injectUser: RequestHandler = (req, _res, next) => {
      (req as typeof req & { user: TestUser }).user = args.user!;
      next();
    };
    app.use(injectUser);
  }

  app.use(
    "/api/pms/listings",
    buildListingsMappingRouter(args.prisma, {
      nodeEnv: args.nodeEnv ?? "production",
    })
  );

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;

  try {
    return await fetch(
      `http://127.0.0.1:${address.port}${args.path}`,
      {
        method: args.method ?? "GET",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
      }
    );
  } finally {
    await closeServer(server);
  }
}

test("production surface excludes the development listing creator", () => {
  const router = buildListingsMappingRouter(createPrisma(), {
    nodeEnv: "production",
  }) as any;
  const paths = router.stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => layer.route.path);

  assert.deepEqual(paths, ["/pending", "/:pmsListingId/map", "/retry-failed/:connectionId"]);
  assert.equal(paths.includes("/dev-create"), false);
});

test("unauthenticated callers are rejected before tenant data is read", async () => {
  let reads = 0;
  const prisma = createPrisma({
    pmsConnection: {
      findFirst: async () => {
        reads += 1;
        return null;
      },
    },
  });
  const response = await requestRoute({
    prisma,
    path: "/api/pms/listings/pending?connectionId=connection-a",
  });

  assert.equal(response.status, 401);
  assert.equal(reads, 0);
});

test("pending listings require connection ownership", async () => {
  let connectionQuery: any;
  let listingReads = 0;
  const prisma = createPrisma({
    pmsConnection: {
      findFirst: async (args: any) => {
        connectionQuery = args;
        return null;
      },
    },
    pmsListing: {
      ...createPrisma().pmsListing,
      findMany: async () => {
        listingReads += 1;
        return [];
      },
    },
  });
  const response = await requestRoute({
    prisma,
    path: "/api/pms/listings/pending?connectionId=connection-b",
    user: { id: "user-a", orgId: "organization-a" },
  });

  assert.equal(response.status, 404);
  assert.deepEqual(connectionQuery.where, {
    id: "connection-b",
    organizationId: "organization-a",
  });
  assert.equal(listingReads, 0);
});

test("mapping rejects a listing or property outside the authenticated tenant", async () => {
  let updates = 0;
  const prisma = createPrisma({
    pmsListing: {
      ...createPrisma().pmsListing,
      findFirst: async () => null,
      updateMany: async () => {
        updates += 1;
        return { count: 1 };
      },
    },
    property: {
      findFirst: async () => ({ id: "property-a" }),
    },
  });
  const response = await requestRoute({
    prisma,
    path: "/api/pms/listings/listing-b/map",
    method: "POST",
    body: { propertyId: "property-a" },
    user: { id: "user-a", orgId: "organization-a" },
  });

  assert.equal(response.status, 404);
  assert.equal(updates, 0);
});

test("failed event retry is scoped to an owned connection", async () => {
  let eventReads = 0;
  const prisma = createPrisma({
    pmsConnection: { findFirst: async () => null },
    webhookEventIngest: {
      findMany: async () => {
        eventReads += 1;
        return [];
      },
      updateMany: async () => ({ count: 0 }),
    },
  });
  const response = await requestRoute({
    prisma,
    path: "/api/pms/listings/retry-failed/connection-b",
    method: "POST",
    user: { id: "user-a", orgId: "organization-a" },
  });

  assert.equal(response.status, 404);
  assert.equal(eventReads, 0);
});

test("development listing creation also requires connection ownership", async () => {
  let creates = 0;
  const prisma = createPrisma({
    pmsConnection: { findFirst: async () => null },
    pmsListing: {
      ...createPrisma().pmsListing,
      create: async () => {
        creates += 1;
        return null;
      },
    },
  });
  const response = await requestRoute({
    prisma,
    path: "/api/pms/listings/dev-create",
    method: "POST",
    body: { connectionId: "connection-b", externalListingId: "listing-b" },
    user: { id: "user-a", orgId: "organization-a" },
    nodeEnv: "development",
  });

  assert.equal(response.status, 404);
  assert.equal(creates, 0);
});
