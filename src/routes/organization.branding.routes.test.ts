import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { organizationBrandingRouter } from "./organization.branding.routes.js";

type TestUser = {
  id: string;
  orgId: string;
  role: string;
};

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: unknown[];
  };
};

type MutablePrisma = {
  dashboardUser: {
    findUnique: (...args: unknown[]) => Promise<unknown>;
  };
  brandProfile: {
    findUnique: (...args: unknown[]) => Promise<unknown>;
  };
  $transaction: (
    operation: (transaction: unknown) => Promise<unknown>,
    options?: unknown
  ) => Promise<unknown>;
};

const mutablePrisma = prisma as unknown as MutablePrisma;

function orgAdmin(): TestUser {
  return {
    id: "org-admin-a",
    orgId: "organization-a",
    role: "ORG_ADMIN",
  };
}

function reviewerRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-admin-a",
    organizationId: "organization-a",
    role: "ORG_ADMIN",
    isActive: true,
    ...overrides,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

async function requestRoute(
  path: string,
  init: RequestInit,
  user?: TestUser
): Promise<Response> {
  const app = express();
  app.use(express.json());

  if (user) {
    const injectUser: RequestHandler = (req, _res, next) => {
      (req as typeof req & { user: TestUser }).user = user;
      next();
    };
    app.use(injectUser);
  }

  app.use(organizationBrandingRouter);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Connection: "close",
        ...init.headers,
      },
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await closeServer(server);
  }
}

async function withPrismaStubs<T>(
  stubs: {
    dashboardUserFindUnique?: (...args: unknown[]) => Promise<unknown>;
    brandProfileFindUnique?: (...args: unknown[]) => Promise<unknown>;
    transaction?: MutablePrisma["$transaction"];
  },
  action: () => Promise<T>
): Promise<T> {
  const originalDashboardUserFindUnique =
    mutablePrisma.dashboardUser.findUnique;
  const originalBrandProfileFindUnique =
    mutablePrisma.brandProfile.findUnique;
  const originalTransaction = mutablePrisma.$transaction;

  if (stubs.dashboardUserFindUnique) {
    mutablePrisma.dashboardUser.findUnique =
      stubs.dashboardUserFindUnique;
  }
  if (stubs.brandProfileFindUnique) {
    mutablePrisma.brandProfile.findUnique =
      stubs.brandProfileFindUnique;
  }
  if (stubs.transaction) {
    mutablePrisma.$transaction = stubs.transaction;
  }

  try {
    return await action();
  } finally {
    mutablePrisma.dashboardUser.findUnique =
      originalDashboardUserFindUnique;
    mutablePrisma.brandProfile.findUnique =
      originalBrandProfileFindUnique;
    mutablePrisma.$transaction = originalTransaction;
  }
}

test("router exposes only review, approve and reject", () => {
  const layers = (
    organizationBrandingRouter as unknown as { stack: RouterLayer[] }
  ).stack;
  const surface = layers
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route!;
      const method = Object.entries(route.methods).find(
        ([, enabled]) => enabled
      )?.[0];
      return `${method?.toUpperCase()} ${route.path}`;
    });

  assert.deepEqual(surface, [
    "GET /api/org/branding/review",
    "POST /api/org/branding/profiles/:brandProfileId/revisions/:brandRevisionId/approve",
    "POST /api/org/branding/profiles/:brandProfileId/revisions/:brandRevisionId/reject",
  ]);
  for (const layer of layers.filter((item) => item.route)) {
    assert.equal(layer.route?.stack.length, 2);
  }
});

test("unauthenticated review request is rejected", async () => {
  const response = await requestRoute(
    "/api/org/branding/review",
    { method: "GET" }
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("PLATFORM_ADMIN and MEMBER are rejected before database reads", async () => {
  let databaseReads = 0;

  await withPrismaStubs(
    {
      dashboardUserFindUnique: async () => {
        databaseReads += 1;
        return reviewerRecord();
      },
    },
    async () => {
      for (const user of [
        {
          id: "platform-admin-a",
          orgId: "pin-go-organization",
          role: "PLATFORM_ADMIN",
        },
        {
          id: "member-a",
          orgId: "organization-a",
          role: "MEMBER",
        },
      ]) {
        const response = await requestRoute(
          "/api/org/branding/review",
          { method: "GET" },
          user
        );
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), {
          ok: false,
          error: "BRAND_REVIEWER_REQUIRED",
        });
      }
    }
  );

  assert.equal(databaseReads, 0);
});

test("inactive or cross-organization reviewer is rejected", async () => {
  for (const record of [
    reviewerRecord({ isActive: false }),
    reviewerRecord({ organizationId: "organization-b" }),
  ]) {
    await withPrismaStubs(
      {
        dashboardUserFindUnique: async () => record,
      },
      async () => {
        const response = await requestRoute(
          "/api/org/branding/review",
          { method: "GET" },
          orgAdmin()
        );
        assert.equal(response.status, 403);
        assert.equal(
          ((await response.json()) as Record<string, unknown>).error,
          "BRAND_REVIEWER_REQUIRED"
        );
      }
    );
  }
});

test("review view returns only the organization's pending identity", async () => {
  let profileQuery: unknown;

  await withPrismaStubs(
    {
      dashboardUserFindUnique: async () => reviewerRecord(),
      brandProfileFindUnique: async (...args) => {
        profileQuery = args[0];
        return {
          id: "brand-profile-a",
          organizationId: "organization-a",
          experienceType: "ENTERPRISE_BRANDED",
          status: "DRAFT",
          activeRevisionId: null,
          activeDomainId: null,
          activeRevision: null,
          activeDomain: null,
          revisions: [
            {
              id: "brand-revision-a",
              version: 1,
              displayName: "Casa Azul Management",
              logoUrl: "https://cdn.example.com/logo.png",
              faviconUrl: "https://cdn.example.com/favicon.png",
              primaryColor: "#155EEF",
              approvalStatus: "PENDING_APPROVAL",
              createdAt: "2026-08-15T20:00:00.000Z",
            },
          ],
        };
      },
    },
    async () => {
      const response = await requestRoute(
        "/api/org/branding/review",
        { method: "GET" },
        orgAdmin()
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: {
          profile: Record<string, unknown>;
          pendingRevisions: Array<Record<string, unknown>>;
        };
      };
      assert.equal(body.data.profile.organizationId, "organization-a");
      assert.equal(body.data.pendingRevisions.length, 1);
      assert.equal(body.data.profile.revisions, undefined);
      assert.equal(body.data.pendingRevisions[0]?.logoPublicId, undefined);
    }
  );

  assert.deepEqual(
    (profileQuery as { where: unknown }).where,
    { organizationId: "organization-a" }
  );
});

test("approved route delegates to atomic review service for the verified owner", async () => {
  const revisionUpdates: unknown[] = [];
  const transactionClient = {
    dashboardUser: {
      findUnique: async () => reviewerRecord(),
    },
    brandProfile: {
      findUnique: async () => ({
        id: "brand-profile-a",
        organizationId: "organization-a",
        experienceType: "ENTERPRISE_BRANDED",
        status: "DRAFT",
      }),
    },
    brandRevision: {
      findUnique: async () => ({
        id: "brand-revision-a",
        brandProfileId: "brand-profile-a",
        version: 1,
        approvalStatus: "PENDING_APPROVAL",
      }),
      update: async (args: unknown) => {
        revisionUpdates.push(args);
        return {
          id: "brand-revision-a",
          approvalStatus: "APPROVED",
          approvedByUserId: "org-admin-a",
        };
      },
    },
  };

  await withPrismaStubs(
    {
      dashboardUserFindUnique: async () => reviewerRecord(),
      transaction: async (operation) => operation(transactionClient),
    },
    async () => {
      const response = await requestRoute(
        "/api/org/branding/profiles/brand-profile-a/revisions/brand-revision-a/approve",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
        orgAdmin()
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: { revision: Record<string, unknown> };
      };
      assert.equal(body.data.revision.approvalStatus, "APPROVED");
    }
  );

  assert.equal(revisionUpdates.length, 1);
  const update = revisionUpdates[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(update.data.approvedByUserId, "org-admin-a");
});

test("reject endpoint requires a textual reason before review transaction", async () => {
  let transactionCalls = 0;

  await withPrismaStubs(
    {
      dashboardUserFindUnique: async () => reviewerRecord(),
      transaction: async () => {
        transactionCalls += 1;
        throw new Error("transaction should not run");
      },
    },
    async () => {
      const response = await requestRoute(
        "/api/org/branding/profiles/brand-profile-a/revisions/brand-revision-a/reject",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
        orgAdmin()
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "ORGANIZATION_BRANDING_INPUT_INVALID",
        field: "rejectionReason",
        message: "rejectionReason must be a string.",
      });
    }
  );

  assert.equal(transactionCalls, 0);
});
