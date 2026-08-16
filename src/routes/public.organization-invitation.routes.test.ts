import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { prisma } from "../lib/prisma.js";
import { publicOrganizationInvitationRouter } from "./public.organization-invitation.routes.js";

const TOKEN = "A".repeat(43);

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: unknown[];
  };
};

type MutablePrisma = {
  organizationInvitation: {
    findUnique: (...args: unknown[]) => Promise<unknown>;
  };
  $transaction: (
    operation: (transaction: unknown) => Promise<unknown>,
    options?: unknown
  ) => Promise<unknown>;
};

const mutablePrisma = prisma as unknown as MutablePrisma;

function openInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "organization-invitation-a",
    organizationId: "organization-a",
    email: "owner@example.com",
    role: "ORG_ADMIN",
    expiresAt: new Date("2099-08-18T20:00:00.000Z"),
    acceptedAt: null,
    revokedAt: null,
    organization: {
      id: "organization-a",
      name: "Casa Azul Management",
    },
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

async function requestRoute(body: Record<string, unknown>): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use(publicOrganizationInvitationRouter);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/public/organization-invitations/accept`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify(body),
      }
    );
    const responseBody = await response.arrayBuffer();
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await closeServer(server);
  }
}

async function inspectInvitation(
  body: Record<string, unknown>
): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use(publicOrganizationInvitationRouter);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/public/organization-invitations/inspect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify(body),
      }
    );
    const responseBody = await response.arrayBuffer();
    return new Response(responseBody, {
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
    invitationFindUnique?: (...args: unknown[]) => Promise<unknown>;
    transaction?: MutablePrisma["$transaction"];
  },
  action: () => Promise<T>
): Promise<T> {
  const originalInvitationFindUnique =
    mutablePrisma.organizationInvitation.findUnique;
  const originalTransaction = mutablePrisma.$transaction;

  if (stubs.invitationFindUnique) {
    mutablePrisma.organizationInvitation.findUnique =
      stubs.invitationFindUnique;
  }
  if (stubs.transaction) {
    mutablePrisma.$transaction = stubs.transaction;
  }

  try {
    return await action();
  } finally {
    mutablePrisma.organizationInvitation.findUnique =
      originalInvitationFindUnique;
    mutablePrisma.$transaction = originalTransaction;
  }
}

test("router exposes only public inspection and acceptance", () => {
  const layers = (
    publicOrganizationInvitationRouter as unknown as {
      stack: RouterLayer[];
    }
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
    "POST /api/public/organization-invitations/inspect",
    "POST /api/public/organization-invitations/accept",
  ]);
});

test("public inspection returns only safe invitation context", async () => {
  let invitationQuery: unknown;

  await withPrismaStubs(
    {
      invitationFindUnique: async (...args) => {
        invitationQuery = args[0];
        return openInvitation();
      },
    },
    async () => {
      const response = await inspectInvitation({ token: TOKEN });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("pragma"), "no-cache");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const body = (await response.json()) as {
        ok: boolean;
        data: Record<string, unknown>;
      };
      assert.equal(body.ok, true);
      assert.deepEqual(body.data, {
        organizationName: "Casa Azul Management",
        ownerEmailHint: "o***@example.com",
        expiresAt: "2099-08-18T20:00:00.000Z",
      });
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes("owner@example.com"), false);
      assert.equal(serialized.includes(TOKEN), false);
      assert.equal(serialized.includes("organization-invitation-a"), false);
      assert.equal(serialized.includes("organization-a"), false);
    }
  );

  const query = invitationQuery as {
    where: { tokenHash: string };
    select: Record<string, unknown>;
  };
  assert.match(query.where.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(query.select.tokenHash, undefined);
});

test("public inspection requires token body before database access", async () => {
  let databaseReads = 0;

  await withPrismaStubs(
    {
      invitationFindUnique: async () => {
        databaseReads += 1;
        return null;
      },
    },
    async () => {
      const response = await inspectInvitation({});
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "ORGANIZATION_INVITATION_INPUT_INVALID",
        field: "token",
        message: "token must be a string.",
      });
    }
  );

  assert.equal(databaseReads, 0);
});

test("public inspection gives every invalid invitation the same response", async () => {
  const states = [
    null,
    openInvitation({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    openInvitation({ revokedAt: new Date("2026-08-15T20:00:00.000Z") }),
    openInvitation({ acceptedAt: new Date("2026-08-15T20:00:00.000Z") }),
    openInvitation({ role: "MEMBER" }),
  ];

  for (const invitation of states) {
    await withPrismaStubs(
      {
        invitationFindUnique: async () => invitation,
      },
      async () => {
        const response = await inspectInvitation({ token: TOKEN });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          ok: false,
          error: "INVALID_OR_EXPIRED_ORGANIZATION_INVITATION",
        });
      }
    );
  }

  const malformed = await inspectInvitation({ token: "invalid-token" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    ok: false,
    error: "INVALID_OR_EXPIRED_ORGANIZATION_INVITATION",
  });
});

test("public inspection failure never exposes internal error text", async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    await withPrismaStubs(
      {
        invitationFindUnique: async () => {
          throw new Error("sensitive inspection database detail");
        },
      },
      async () => {
        const response = await inspectInvitation({ token: TOKEN });
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.equal(
          body.includes("sensitive inspection database detail"),
          false
        );
        assert.deepEqual(JSON.parse(body), {
          ok: false,
          error: "ORGANIZATION_INVITATION_INSPECTION_FAILED",
        });
      }
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("missing body fields fail before database access", async () => {
  let databaseReads = 0;

  await withPrismaStubs(
    {
      invitationFindUnique: async () => {
        databaseReads += 1;
        return null;
      },
    },
    async () => {
      const response = await requestRoute({});
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "ORGANIZATION_INVITATION_INPUT_INVALID",
        field: "token",
        message: "token must be a string.",
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("pragma"), "no-cache");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
  );

  assert.equal(databaseReads, 0);
});

test("malformed token uses the uniform public invitation error", async () => {
  const response = await requestRoute({
    token: "invalid-token",
    fullName: "Elena Rivera",
    password: "Secure!Pass2026",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "INVALID_OR_EXPIRED_ORGANIZATION_INVITATION",
  });
});

test("weak password returns only actionable policy details", async () => {
  await withPrismaStubs(
    {
      invitationFindUnique: async () => openInvitation(),
    },
    async () => {
      const response = await requestRoute({
        token: TOKEN,
        fullName: "Elena Rivera",
        password: "password123",
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as {
        error: string;
        details: string[];
      };
      assert.equal(
        body.error,
        "ORGANIZATION_INVITATION_PASSWORD_WEAK"
      );
      assert.ok(body.details.length > 0);
      assert.equal("context" in body, false);
    }
  );
});

test("expired, revoked and accepted tokens share the same public response", async () => {
  const states = [
    openInvitation({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    openInvitation({ revokedAt: new Date("2026-08-15T20:00:00.000Z") }),
    openInvitation({ acceptedAt: new Date("2026-08-15T20:00:00.000Z") }),
  ];

  for (const invitation of states) {
    await withPrismaStubs(
      {
        invitationFindUnique: async () => invitation,
      },
      async () => {
        const response = await requestRoute({
          token: TOKEN,
          fullName: "Elena Rivera",
          password: "Secure!Pass2026",
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          ok: false,
          error: "INVALID_OR_EXPIRED_ORGANIZATION_INVITATION",
        });
      }
    );
  }
});

test("email registered during acceptance returns conflict without account data", async () => {
  const transactionClient = {
    organizationInvitation: {
      findUnique: async () => openInvitation(),
    },
    dashboardUser: {
      findUnique: async () => ({ id: "existing-user" }),
    },
  };

  await withPrismaStubs(
    {
      invitationFindUnique: async () => openInvitation(),
      transaction: async (operation) => operation(transactionClient),
    },
    async () => {
      const response = await requestRoute({
        token: TOKEN,
        fullName: "Elena Rivera",
        password: "Secure!Pass2026",
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "ORGANIZATION_INVITATION_EMAIL_REGISTERED",
      });
    }
  );
});

test("successful acceptance returns only safe owner and organization data", async () => {
  const userCreates: Array<{ data: Record<string, unknown> }> = [];
  const invitationConsumes: unknown[] = [];
  const transactionClient = {
    organizationInvitation: {
      findUnique: async () => openInvitation(),
      updateMany: async (args: unknown) => {
        invitationConsumes.push(args);
        return { count: 1 };
      },
    },
    dashboardUser: {
      findUnique: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        userCreates.push(args);
        return {
          id: "organization-owner-a",
          organizationId: "organization-a",
          email: "owner@example.com",
          fullName: "Elena Rivera",
          role: "ORG_ADMIN",
          isActive: true,
          tokenVersion: 1,
          createdAt: new Date("2026-08-15T20:00:00.000Z"),
        };
      },
    },
  };

  await withPrismaStubs(
    {
      invitationFindUnique: async () => openInvitation(),
      transaction: async (operation) => operation(transactionClient),
    },
    async () => {
      const response = await requestRoute({
        token: TOKEN,
        fullName: "Elena Rivera",
        password: "Secure!Pass2026",
      });
      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        data: {
          user: Record<string, unknown>;
          organizationId: string;
          acceptedAt: string;
        };
      };
      assert.equal(body.data.user.role, "ORG_ADMIN");
      assert.equal(body.data.organizationId, "organization-a");
      assert.equal(body.data.user.passwordHash, undefined);
      assert.equal(body.data.user.token, undefined);
      assert.equal(body.data.acceptedAt.length > 0, true);
    }
  );

  assert.equal(userCreates.length, 1);
  assert.equal(
    typeof userCreates[0]?.data.passwordHash,
    "string"
  );
  assert.equal(invitationConsumes.length, 1);
});

test("unexpected failure does not expose internal error text", async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    await withPrismaStubs(
      {
        invitationFindUnique: async () => {
          throw new Error("sensitive database detail");
        },
      },
      async () => {
        const response = await requestRoute({
          token: TOKEN,
          fullName: "Elena Rivera",
          password: "Secure!Pass2026",
        });
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.equal(body.includes("sensitive database detail"), false);
        assert.deepEqual(JSON.parse(body), {
          ok: false,
          error: "ORGANIZATION_INVITATION_ACCEPTANCE_FAILED",
        });
      }
    );
  } finally {
    console.error = originalConsoleError;
  }
});
