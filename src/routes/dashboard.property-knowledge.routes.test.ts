import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type RequestHandler } from "express";

import {
  buildDashboardPropertyKnowledgeRouter,
  type PropertyKnowledgeAdminPrisma,
} from "./dashboard.property-knowledge.routes.js";

type TestUser = { id: string; orgId: string; role: string };

type Entry = {
  id: string;
  propertyId: string;
  category: string;
  key: string;
  titleEn: string | null;
  titleEs: string | null;
  contentEn: string | null;
  contentEs: string | null;
  visibility: string;
  sortOrder: number;
  revision: number;
  isActive: boolean;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function createMemoryPrisma() {
  const entries: Entry[] = [];
  const calls = {
    propertyReads: 0,
    entryReads: 0,
    creates: 0,
    updates: 0,
  };

  const belongsToTenant = (where: any) =>
    where?.property?.organizationId === undefined ||
    where.property.organizationId === "org-a";

  const prisma: PropertyKnowledgeAdminPrisma = {
    property: {
      async findFirst(args: any) {
        calls.propertyReads += 1;
        return args.where?.id === "property-a" &&
          args.where?.organizationId === "org-a" &&
          args.where?.status === "ACTIVE"
          ? { id: "property-a" }
          : null;
      },
    },
    propertyKnowledgeEntry: {
      async findMany(args: any) {
        calls.entryReads += 1;
        return entries.filter(
          (entry) =>
            entry.propertyId === args.where?.propertyId &&
            (args.where?.isActive === undefined ||
              entry.isActive === args.where.isActive),
        );
      },
      async findFirst(args: any) {
        calls.entryReads += 1;
        return (
          entries.find(
            (entry) =>
              entry.id === args.where?.id &&
              entry.propertyId === args.where?.propertyId &&
              belongsToTenant(args.where) &&
              (args.where?.isActive === undefined ||
                entry.isActive === args.where.isActive),
          ) ?? null
        );
      },
      async create(args: any) {
        calls.creates += 1;
        if (
          entries.some(
            (entry) =>
              entry.propertyId === args.data.propertyId &&
              entry.key === args.data.key,
          )
        ) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }

        const now = new Date("2026-09-21T12:00:00.000Z");
        const entry: Entry = {
          id: `entry-${entries.length + 1}`,
          ...args.data,
          revision: 1,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        };
        entries.push(entry);
        return entry;
      },
      async updateMany(args: any) {
        calls.updates += 1;
        const entry = entries.find(
          (candidate) =>
            candidate.id === args.where?.id &&
            candidate.propertyId === args.where?.propertyId &&
            candidate.revision === args.where?.revision &&
            candidate.isActive === args.where?.isActive &&
            belongsToTenant(args.where),
        );
        if (!entry) return { count: 0 };

        for (const [key, value] of Object.entries(args.data)) {
          if (key === "revision") {
            entry.revision += Number((value as any).increment ?? 0);
          } else {
            (entry as any)[key] = value;
          }
        }
        entry.updatedAt = new Date("2026-09-21T12:01:00.000Z");
        return { count: 1 };
      },
    },
  };

  return { prisma, entries, calls };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function requestRoute(args: {
  prisma: PropertyKnowledgeAdminPrisma;
  user?: TestUser;
  path?: string;
  method?: string;
  body?: Record<string, unknown>;
}) {
  const previousCi = process.env.CI;
  process.env.CI = "true";

  const app = express();
  if (args.user) {
    const injectUser: RequestHandler = (req, _res, next) => {
      (req as typeof req & { user: TestUser }).user = args.user!;
      next();
    };
    app.use(injectUser);
  }
  app.use(express.json());
  app.use(buildDashboardPropertyKnowledgeRouter(args.prisma));

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;

  try {
    return await fetch(
      `http://127.0.0.1:${address.port}${
        args.path ??
        "/api/dashboard/properties/property-a/property-knowledge"
      }`,
      {
        method: args.method ?? "GET",
        headers: {
          Connection: "close",
          ...(args.body ? { "Content-Type": "application/json" } : {}),
        },
        body: args.body ? JSON.stringify(args.body) : undefined,
      },
    );
  } finally {
    await closeServer(server);
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
}

const admin: TestUser = {
  id: "user-a",
  orgId: "org-a",
  role: "ORG_ADMIN",
};

const validDraft = {
  category: "PARKING",
  key: "parking.instructions",
  titleEn: "Parking",
  titleEs: "Estacionamiento",
  contentEn: "Use the marked space.",
  contentEs: "Use el espacio marcado.",
  visibility: "CONFIRMED_GUEST",
  sortOrder: 10,
};

test("requires authentication and an administrative role before database access", async () => {
  const { prisma, calls } = createMemoryPrisma();

  const unauthenticated = await requestRoute({ prisma });
  assert.equal(unauthenticated.status, 401);

  const member = await requestRoute({
    prisma,
    user: { id: "member-a", orgId: "org-a", role: "MEMBER" },
  });
  assert.equal(member.status, 403);
  assert.equal(calls.propertyReads, 0);
  assert.equal(calls.entryReads, 0);
});

test("hard-scopes list access to the actor organization and property", async () => {
  const { prisma, calls } = createMemoryPrisma();
  const response = await requestRoute({
    prisma,
    user: { ...admin, orgId: "org-b" },
  });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "PROPERTY_KNOWLEDGE_PROPERTY_NOT_FOUND",
  });
  assert.equal(calls.entryReads, 0);
});

test("rejects unknown fields and access credentials before writes", async () => {
  const { prisma, calls } = createMemoryPrisma();

  const unknown = await requestRoute({
    prisma,
    user: admin,
    method: "POST",
    body: { ...validDraft, activePasscode: "123456" },
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json() as any).error, "PROPERTY_KNOWLEDGE_FIELD_NOT_ALLOWED");

  const credential = await requestRoute({
    prisma,
    user: admin,
    method: "POST",
    body: {
      ...validDraft,
      category: "ACCESS",
      key: "access.door.code",
    },
  });
  assert.equal(credential.status, 400);
  assert.equal(
    (await credential.json() as any).error,
    "PROPERTY_KNOWLEDGE_ACCESS_CREDENTIAL_FORBIDDEN",
  );
  assert.equal(calls.creates, 0);
});

test("creates a tenant-scoped entry without returning actor identifiers", async () => {
  const { prisma, entries } = createMemoryPrisma();
  const response = await requestRoute({
    prisma,
    user: admin,
    method: "POST",
    body: validDraft,
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as any;
  assert.equal(body.entry.revision, 1);
  assert.equal(body.entry.createdByUserId, undefined);
  assert.equal(body.entry.updatedByUserId, undefined);
  assert.equal(entries[0].createdByUserId, "user-a");
  assert.equal(entries[0].updatedByUserId, "user-a");
});

test("updates only the expected active revision", async () => {
  const memory = createMemoryPrisma();
  await requestRoute({
    prisma: memory.prisma,
    user: admin,
    method: "POST",
    body: validDraft,
  });

  const stale = await requestRoute({
    prisma: memory.prisma,
    user: admin,
    method: "PATCH",
    path: "/api/dashboard/properties/property-a/property-knowledge/entry-1",
    body: { expectedRevision: 2, contentEn: "Stale edit" },
  });
  assert.equal(stale.status, 409);
  assert.equal(memory.entries[0].contentEn, validDraft.contentEn);

  const updated = await requestRoute({
    prisma: memory.prisma,
    user: admin,
    method: "PATCH",
    path: "/api/dashboard/properties/property-a/property-knowledge/entry-1",
    body: { expectedRevision: 1, contentEn: "Updated parking details." },
  });
  assert.equal(updated.status, 200);
  const body = await updated.json() as any;
  assert.equal(body.entry.revision, 2);
  assert.equal(body.entry.contentEn, "Updated parking details.");
});

test("deactivates without physically deleting the entry", async () => {
  const memory = createMemoryPrisma();
  await requestRoute({
    prisma: memory.prisma,
    user: admin,
    method: "POST",
    body: validDraft,
  });

  const response = await requestRoute({
    prisma: memory.prisma,
    user: admin,
    method: "DELETE",
    path: "/api/dashboard/properties/property-a/property-knowledge/entry-1",
    body: { expectedRevision: 1 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    entryId: "entry-1",
    isActive: false,
    revision: 2,
  });
  assert.equal(memory.entries.length, 1);
  assert.equal(memory.entries[0].isActive, false);
});
