import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { adminBrandingRouter } from "./admin.branding.routes.js";

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
  $transaction: (
    operation: (transaction: unknown) => Promise<unknown>,
    options?: unknown
  ) => Promise<unknown>;
};

const mutablePrisma = prisma as unknown as MutablePrisma;

async function withTransactionStub<T>(
  transaction: MutablePrisma["$transaction"],
  action: () => Promise<T>
): Promise<T> {
  const originalTransaction = mutablePrisma.$transaction;
  mutablePrisma.$transaction = transaction;
  try {
    return await action();
  } finally {
    mutablePrisma.$transaction = originalTransaction;
  }
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

  app.use(adminBrandingRouter);
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

function platformAdmin(): TestUser {
  return {
    id: "platform-admin-a",
    orgId: "pin-go-organization",
    role: "PLATFORM_ADMIN",
  };
}

function validIdentity() {
  return {
    displayName: "Casa Azul Management",
    logoUrl: "https://cdn.example.com/logo.png",
    logoPublicId: "brands/casa-azul/logo",
    faviconUrl: "https://cdn.example.com/favicon.png",
    faviconPublicId: "brands/casa-azul/favicon",
    primaryColor: "#155EEF",
  };
}

test("router exposes only the ten approved internal operations", () => {
  const layers = (
    adminBrandingRouter as unknown as { stack: RouterLayer[] }
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
    "POST /api/internal/admin/branding/enterprise-onboarding",
    "POST /api/internal/admin/branding/organizations/:organizationId/initialize",
    "POST /api/internal/admin/branding/profiles/:brandProfileId/revisions",
    "POST /api/internal/admin/branding/profiles/:brandProfileId/revisions/:brandRevisionId/submit",
    "POST /api/internal/admin/branding/profiles/:brandProfileId/domains",
    "PATCH /api/internal/admin/branding/profiles/:brandProfileId/domains/:brandDomainId/status",
    "POST /api/internal/admin/branding/profiles/:brandProfileId/publish",
    "POST /api/internal/admin/branding/profiles/:brandProfileId/suspend",
    "POST /api/internal/admin/branding/organizations/:organizationId/owner-invitations",
    "POST /api/internal/admin/branding/owner-invitations/:invitationId/revoke",
  ]);

  for (const layer of layers.filter((item) => item.route)) {
    assert.equal(layer.route?.stack.length, 2);
  }
});

test("unauthenticated request is rejected before administrative action", async () => {
  const response = await requestRoute(
    "/api/internal/admin/branding/enterprise-onboarding",
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("organization roles are rejected even with an authenticated session", async () => {
  for (const role of ["ORG_ADMIN", "ADMIN", "MEMBER"]) {
    const response = await requestRoute(
      "/api/internal/admin/branding/enterprise-onboarding",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      {
        id: `${role.toLowerCase()}-a`,
        orgId: "organization-a",
        role,
      }
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "PLATFORM_ADMIN_REQUIRED",
    });
  }
});

test("enterprise onboarding validates required fields before opening a transaction", async () => {
  let transactionCount = 0;

  await withTransactionStub(
    async () => {
      transactionCount += 1;
      throw new Error("transaction must not open");
    },
    async () => {
      const response = await requestRoute(
        "/api/internal/admin/branding/enterprise-onboarding",
        {
          method: "POST",
          body: JSON.stringify({
            organizationName: "Casa Azul Management",
          }),
        },
        platformAdmin()
      );

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "ADMIN_BRANDING_INPUT_INVALID",
        field: "organizationSlug",
        message: "organizationSlug must be a string.",
      });
    }
  );

  assert.equal(transactionCount, 0);
});

test("enterprise onboarding returns one safe invitation token after atomic provisioning", async () => {
  let transactionCount = 0;
  let transactionOptions: unknown;
  let invitationCreate: unknown;
  let dashboardUserCreateCount = 0;

  const transactionClient = {
    dashboardUser: {
      findUnique: async (args: { where: Record<string, string> }) => {
        if (args.where.id === "platform-admin-a") {
          return {
            id: "platform-admin-a",
            role: "PLATFORM_ADMIN",
            isActive: true,
          };
        }
        return null;
      },
      create: async () => {
        dashboardUserCreateCount += 1;
        throw new Error("owner must not be created during onboarding");
      },
    },
    organization: {
      findUnique: async () => null,
      create: async () => ({
        id: "organization-a",
        name: "Casa Azul Management",
        slug: "casa-azul-management",
        createdAt: new Date("2026-08-15T20:00:00.000Z"),
      }),
    },
    brandProfile: {
      create: async () => ({
        id: "brand-profile-a",
        organizationId: "organization-a",
        experienceType: "ENTERPRISE_BRANDED",
        status: "DRAFT",
      }),
    },
    brandRevision: {
      create: async () => ({
        id: "brand-revision-a",
        brandProfileId: "brand-profile-a",
        version: 1,
        approvalStatus: "DRAFT",
      }),
    },
    brandDomain: {
      findUnique: async () => null,
      create: async () => ({
        id: "brand-domain-a",
        brandProfileId: "brand-profile-a",
        hostname: "portal.casa-azul.example",
        type: "CUSTOM_DOMAIN",
        status: "PENDING_CONFIGURATION",
      }),
    },
    organizationInvitation: {
      create: async (args: unknown) => {
        invitationCreate = args;
        return {
          id: "invitation-a",
          organizationId: "organization-a",
          email: "owner@casa-azul.example",
          role: "ORG_ADMIN",
          expiresAt: new Date("2026-08-18T20:00:00.000Z"),
          createdAt: new Date("2026-08-15T20:00:00.000Z"),
        };
      },
    },
  };

  await withTransactionStub(
    async (operation, options) => {
      transactionCount += 1;
      transactionOptions = options;
      return operation(transactionClient);
    },
    async () => {
      const response = await requestRoute(
        "/api/internal/admin/branding/enterprise-onboarding",
        {
          method: "POST",
          body: JSON.stringify({
            organizationName: "Casa Azul Management",
            organizationSlug: "casa-azul-management",
            ownerEmail: "owner@casa-azul.example",
            ...validIdentity(),
            hostname: "portal.casa-azul.example",
            domainType: "CUSTOM_DOMAIN",
          }),
        },
        platformAdmin()
      );

      assert.equal(response.status, 201);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = (await response.json()) as {
        ok: boolean;
        data: {
          invitationToken: string;
          organization: Record<string, unknown>;
          invitation: Record<string, unknown>;
        };
      };
      assert.equal(body.ok, true);
      assert.equal(body.data.organization.id, "organization-a");
      assert.equal(body.data.invitation.email, "owner@casa-azul.example");
      assert.match(body.data.invitationToken, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(body.data.invitation.tokenHash, undefined);

      const persistedInvitation = invitationCreate as {
        data: { tokenHash: string };
      };
      assert.match(persistedInvitation.data.tokenHash, /^[a-f0-9]{64}$/);
      assert.notEqual(
        persistedInvitation.data.tokenHash,
        body.data.invitationToken
      );
    }
  );

  assert.equal(transactionCount, 1);
  assert.deepEqual(transactionOptions, { isolationLevel: "Serializable" });
  assert.equal(dashboardUserCreateCount, 0);
});

test("PLATFORM_ADMIN receives controlled validation for incomplete identity", async () => {
  const response = await requestRoute(
    "/api/internal/admin/branding/organizations/organization-a/initialize",
    {
      method: "POST",
      body: JSON.stringify({
        displayName: "Casa Azul Management",
      }),
    },
    platformAdmin()
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "ADMIN_BRANDING_INPUT_INVALID",
    field: "logoUrl",
    message: "logoUrl must be a string.",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("invalid domain type is rejected before service or database access", async () => {
  const response = await requestRoute(
    "/api/internal/admin/branding/organizations/organization-a/initialize",
    {
      method: "POST",
      body: JSON.stringify({
        ...validIdentity(),
        hostname: "portal.casa-azul.example",
        domainType: "UNKNOWN_DOMAIN",
      }),
    },
    platformAdmin()
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, "ADMIN_BRANDING_INPUT_INVALID");
  assert.equal(body.field, "domainType");
});

test("invalid domain status is rejected before service or database access", async () => {
  const response = await requestRoute(
    "/api/internal/admin/branding/profiles/brand-profile-a/domains/brand-domain-a/status",
    {
      method: "PATCH",
      body: JSON.stringify({ toStatus: "UNKNOWN" }),
    },
    platformAdmin()
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, "ADMIN_BRANDING_INPUT_INVALID");
  assert.equal(body.field, "toStatus");
});

test("invalid redirect date is rejected before service or database access", async () => {
  const response = await requestRoute(
    "/api/internal/admin/branding/profiles/brand-profile-a/domains/brand-domain-a/status",
    {
      method: "PATCH",
      body: JSON.stringify({
        toStatus: "VERIFYING",
        redirectUntil: "not-a-date",
      }),
    },
    platformAdmin()
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "ADMIN_BRANDING_INPUT_INVALID",
    field: "redirectUntil",
    message: "redirectUntil must be a valid ISO date string.",
  });
});
