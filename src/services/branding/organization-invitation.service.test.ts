import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  acceptOrganizationOwnerInvitation,
  createOrganizationOwnerInvitation,
  inspectOrganizationOwnerInvitation,
  OrganizationInvitationError,
  revokeOrganizationOwnerInvitation,
  type OrganizationInvitationServiceOptions,
} from "./organization-invitation.service.js";
import { BrandPolicyError } from "./brand-policy.js";

type ServiceDb = NonNullable<OrganizationInvitationServiceOptions["db"]>;

const TOKEN = "A".repeat(43);
const TOKEN_HASH = createHash("sha256")
  .update(TOKEN, "utf8")
  .digest("hex");
const NOW = new Date("2026-08-15T20:00:00.000Z");

function openInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "organization-invitation-a",
    organizationId: "organization-a",
    email: "owner@example.com",
    role: "ORG_ADMIN",
    expiresAt: new Date("2026-08-18T19:59:59.000Z"),
    acceptedAt: null,
    revokedAt: null,
    organization: {
      id: "organization-a",
      name: "Casa Azul Management",
    },
    ...overrides,
  };
}

type MockInput = {
  actor?: unknown;
  organization?: unknown;
  existingUser?: unknown;
  invitation?: unknown;
  consumeCount?: number;
};

function mockOrganizationInvitationDb(input: MockInput = {}) {
  const calls = {
    transactions: 0,
    actorFindUnique: [] as unknown[],
    userFindUnique: [] as unknown[],
    userCreate: [] as unknown[],
    organizationFindUnique: [] as unknown[],
    invitationFindUnique: [] as unknown[],
    invitationUpdateMany: [] as unknown[],
    invitationCreate: [] as unknown[],
    invitationUpdate: [] as unknown[],
  };

  const dashboardUser = {
    findUnique: async (args: { where: Record<string, unknown> }) => {
      if ("id" in args.where) {
        calls.actorFindUnique.push(args);
        return input.actor === undefined
          ? {
              id: "platform-admin-a",
              role: "PLATFORM_ADMIN",
              isActive: true,
            }
          : input.actor;
      }

      calls.userFindUnique.push(args);
      return input.existingUser ?? null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      calls.userCreate.push(args);
      return {
        id: "organization-owner-a",
        createdAt: NOW,
        ...args.data,
      };
    },
  };

  const organizationInvitation = {
    findUnique: async (args: unknown) => {
      calls.invitationFindUnique.push(args);
      return input.invitation ?? null;
    },
    updateMany: async (args: {
      data: Record<string, unknown>;
    }) => {
      calls.invitationUpdateMany.push(args);
      return "acceptedAt" in args.data
        ? { count: input.consumeCount ?? 1 }
        : { count: 0 };
    },
    create: async (args: { data: Record<string, unknown> }) => {
      calls.invitationCreate.push(args);
      return {
        id: "organization-invitation-created",
        createdAt: NOW,
        ...args.data,
      };
    },
    update: async (args: { data: Record<string, unknown> }) => {
      calls.invitationUpdate.push(args);
      return {
        id: "organization-invitation-a",
        acceptedAt: null,
        ...args.data,
      };
    },
  };

  const transaction = {
    dashboardUser,
    organization: {
      findUnique: async (args: unknown) => {
        calls.organizationFindUnique.push(args);
        return input.organization === undefined
          ? { id: "organization-a", name: "Casa Azul Management" }
          : input.organization;
      },
    },
    organizationInvitation,
  };

  const db = {
    dashboardUser,
    organizationInvitation,
    $transaction: async (
      operation: (tx: typeof transaction) => Promise<unknown>
    ) => {
      calls.transactions += 1;
      return operation(transaction);
    },
  } as unknown as ServiceDb;

  return { db, calls };
}

function assertInvitationError(
  error: unknown,
  code: OrganizationInvitationError["code"]
): boolean {
  assert.ok(error instanceof OrganizationInvitationError);
  assert.equal(error.code, code);
  return true;
}

test("PLATFORM_ADMIN creates a 72-hour owner invitation without persisting raw token", async () => {
  const { db, calls } = mockOrganizationInvitationDb();

  const result = await createOrganizationOwnerInvitation(
    {
      actor: { userId: "platform-admin-a" },
      organizationId: " organization-a ",
      email: " Owner@Example.COM ",
    },
    {
      db,
      now: () => NOW,
      generateToken: () => TOKEN,
    }
  );

  assert.equal(calls.transactions, 1);
  assert.equal(calls.invitationUpdateMany.length, 1);
  assert.equal(calls.invitationCreate.length, 1);

  const revokePrevious = calls.invitationUpdateMany[0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  assert.equal(revokePrevious.where.organizationId, "organization-a");
  assert.equal(revokePrevious.where.email, "owner@example.com");
  assert.equal(revokePrevious.data.revokedAt, NOW);

  const create = calls.invitationCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(create.data.email, "owner@example.com");
  assert.equal(create.data.role, "ORG_ADMIN");
  assert.equal(create.data.tokenHash, TOKEN_HASH);
  assert.notEqual(create.data.tokenHash, TOKEN);
  assert.equal(
    (create.data.expiresAt as Date).getTime() - NOW.getTime(),
    72 * 60 * 60 * 1000
  );
  assert.equal(result.token, TOKEN);
});

test("invitation manager role is verified from the database", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    actor: {
      id: "org-admin-a",
      role: "ORG_ADMIN",
      isActive: true,
    },
  });

  await assert.rejects(
    createOrganizationOwnerInvitation(
      {
        actor: { userId: "org-admin-a" },
        organizationId: "organization-a",
        email: "owner@example.com",
      },
      { db, now: () => NOW, generateToken: () => TOKEN }
    ),
    (error) => {
      assert.ok(error instanceof BrandPolicyError);
      assert.equal(error.code, "BRAND_MANAGER_REQUIRED");
      return true;
    }
  );
  assert.equal(calls.invitationCreate.length, 0);
});

test("registered email cannot receive an owner invitation", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    existingUser: { id: "existing-user" },
  });

  await assert.rejects(
    createOrganizationOwnerInvitation(
      {
        actor: { userId: "platform-admin-a" },
        organizationId: "organization-a",
        email: "owner@example.com",
      },
      { db, now: () => NOW, generateToken: () => TOKEN }
    ),
    (error) =>
      assertInvitationError(
        error,
        "ORGANIZATION_INVITATION_EMAIL_REGISTERED"
      )
  );
  assert.equal(calls.invitationCreate.length, 0);
});

test("public inspection returns only masked open-invitation context", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    invitation: openInvitation(),
  });

  const result = await inspectOrganizationOwnerInvitation(
    { token: TOKEN },
    { db, now: () => NOW }
  );

  assert.deepEqual(result, {
    organizationName: "Casa Azul Management",
    ownerEmailHint: "o***@example.com",
    expiresAt: new Date("2026-08-18T19:59:59.000Z"),
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "expiresAt",
    "organizationName",
    "ownerEmailHint",
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("owner@example.com"), false);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(TOKEN_HASH), false);
  assert.equal(serialized.includes("organization-invitation-a"), false);
  assert.equal(serialized.includes("organization-a"), false);
  assert.equal(calls.invitationFindUnique.length, 1);
  assert.equal(calls.transactions, 0);

  const query = calls.invitationFindUnique[0] as {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
  };
  assert.equal(query.where.tokenHash, TOKEN_HASH);
  assert.equal(query.select.tokenHash, undefined);
});

test("public inspection rejects malformed token before database access", async () => {
  const { db, calls } = mockOrganizationInvitationDb();

  await assert.rejects(
    inspectOrganizationOwnerInvitation(
      { token: "not-a-valid-token" },
      { db, now: () => NOW }
    ),
    (error) =>
      assertInvitationError(
        error,
        "ORGANIZATION_INVITATION_INPUT_INVALID"
      )
  );
  assert.equal(calls.invitationFindUnique.length, 0);
  assert.equal(calls.transactions, 0);
});

test("public inspection rejects missing or closed owner invitations", async () => {
  const cases = [
    {
      invitation: null,
      code: "ORGANIZATION_INVITATION_NOT_FOUND",
    },
    {
      invitation: openInvitation({ expiresAt: NOW }),
      code: "ORGANIZATION_INVITATION_EXPIRED",
    },
    {
      invitation: openInvitation({ revokedAt: new Date(NOW.getTime() - 1) }),
      code: "ORGANIZATION_INVITATION_REVOKED",
    },
    {
      invitation: openInvitation({ acceptedAt: new Date(NOW.getTime() - 1) }),
      code: "ORGANIZATION_INVITATION_ALREADY_ACCEPTED",
    },
    {
      invitation: openInvitation({ role: "MEMBER" }),
      code: "ORGANIZATION_INVITATION_ROLE_INVALID",
    },
  ] as const;

  for (const item of cases) {
    const { db, calls } = mockOrganizationInvitationDb({
      invitation: item.invitation,
    });
    await assert.rejects(
      inspectOrganizationOwnerInvitation(
        { token: TOKEN },
        { db, now: () => NOW }
      ),
      (error) => assertInvitationError(error, item.code)
    );
    assert.equal(calls.invitationFindUnique.length, 1);
    assert.equal(calls.transactions, 0);
  }
});

test("acceptance creates ORG_ADMIN only after valid token and password", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    invitation: openInvitation(),
  });
  const hashedPasswords: string[] = [];

  const result = await acceptOrganizationOwnerInvitation(
    {
      token: TOKEN,
      fullName: "  Elena Rivera  ",
      password: "Secure!Pass2026",
    },
    {
      db,
      now: () => NOW,
      passwordHasher: async (password) => {
        hashedPasswords.push(password);
        return "hashed-owner-password";
      },
    }
  );

  assert.deepEqual(hashedPasswords, ["Secure!Pass2026"]);
  assert.equal(calls.transactions, 1);
  assert.equal(calls.userCreate.length, 1);
  const userCreate = calls.userCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(userCreate.data, {
    organizationId: "organization-a",
    email: "owner@example.com",
    passwordHash: "hashed-owner-password",
    fullName: "Elena Rivera",
    role: "ORG_ADMIN",
    isActive: true,
    tokenVersion: 1,
  });

  const consume = calls.invitationUpdateMany[0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  assert.equal(consume.where.tokenHash, TOKEN_HASH);
  assert.equal(consume.data.acceptedAt, NOW);
  assert.equal(consume.data.acceptedUserId, "organization-owner-a");
  assert.equal(result.user.role, "ORG_ADMIN");
});

test("weak password fails before hashing and owner creation", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    invitation: openInvitation(),
  });
  let passwordHasherCalls = 0;

  await assert.rejects(
    acceptOrganizationOwnerInvitation(
      {
        token: TOKEN,
        fullName: "Elena Rivera",
        password: "password123",
      },
      {
        db,
        now: () => NOW,
        passwordHasher: async () => {
          passwordHasherCalls += 1;
          return "unused";
        },
      }
    ),
    (error) =>
      assertInvitationError(
        error,
        "ORGANIZATION_INVITATION_PASSWORD_WEAK"
      )
  );
  assert.equal(passwordHasherCalls, 0);
  assert.equal(calls.transactions, 0);
  assert.equal(calls.userCreate.length, 0);
});

test("expired, revoked or accepted invitation fails before owner creation", async () => {
  const cases = [
    {
      invitation: openInvitation({ expiresAt: NOW }),
      code: "ORGANIZATION_INVITATION_EXPIRED",
    },
    {
      invitation: openInvitation({ revokedAt: new Date(NOW.getTime() - 1) }),
      code: "ORGANIZATION_INVITATION_REVOKED",
    },
    {
      invitation: openInvitation({ acceptedAt: new Date(NOW.getTime() - 1) }),
      code: "ORGANIZATION_INVITATION_ALREADY_ACCEPTED",
    },
  ] as const;

  for (const item of cases) {
    const { db, calls } = mockOrganizationInvitationDb({
      invitation: item.invitation,
    });
    await assert.rejects(
      acceptOrganizationOwnerInvitation(
        {
          token: TOKEN,
          fullName: "Elena Rivera",
          password: "Secure!Pass2026",
        },
        {
          db,
          now: () => NOW,
          passwordHasher: async () => "unused",
        }
      ),
      (error) => assertInvitationError(error, item.code)
    );
    assert.equal(calls.transactions, 0);
    assert.equal(calls.userCreate.length, 0);
  }
});

test("invitation can be consumed exactly once under a race", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    invitation: openInvitation(),
    consumeCount: 0,
  });

  await assert.rejects(
    acceptOrganizationOwnerInvitation(
      {
        token: TOKEN,
        fullName: "Elena Rivera",
        password: "Secure!Pass2026",
      },
      {
        db,
        now: () => NOW,
        passwordHasher: async () => "hashed-owner-password",
      }
    ),
    (error) =>
      assertInvitationError(
        error,
        "ORGANIZATION_INVITATION_ALREADY_ACCEPTED"
      )
  );
  assert.equal(calls.invitationUpdateMany.length, 1);
});

test("email registered after invitation creation blocks acceptance", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    invitation: openInvitation(),
    existingUser: { id: "existing-user" },
  });

  await assert.rejects(
    acceptOrganizationOwnerInvitation(
      {
        token: TOKEN,
        fullName: "Elena Rivera",
        password: "Secure!Pass2026",
      },
      {
        db,
        now: () => NOW,
        passwordHasher: async () => "hashed-owner-password",
      }
    ),
    (error) =>
      assertInvitationError(
        error,
        "ORGANIZATION_INVITATION_EMAIL_REGISTERED"
      )
  );
  assert.equal(calls.userCreate.length, 0);
});

test("only an ORG_ADMIN owner invitation can be accepted", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    invitation: openInvitation({ role: "MEMBER" }),
  });

  await assert.rejects(
    acceptOrganizationOwnerInvitation(
      {
        token: TOKEN,
        fullName: "Elena Rivera",
        password: "Secure!Pass2026",
      },
      {
        db,
        now: () => NOW,
        passwordHasher: async () => "unused",
      }
    ),
    (error) =>
      assertInvitationError(
        error,
        "ORGANIZATION_INVITATION_ROLE_INVALID"
      )
  );
  assert.equal(calls.userCreate.length, 0);
});

test("PLATFORM_ADMIN can revoke a pending invitation idempotently", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    invitation: {
      id: "organization-invitation-a",
      acceptedAt: null,
      revokedAt: null,
    },
  });

  const result = await revokeOrganizationOwnerInvitation(
    {
      actor: { userId: "platform-admin-a" },
      invitationId: "organization-invitation-a",
    },
    { db, now: () => NOW }
  );

  assert.equal(calls.invitationUpdate.length, 1);
  assert.equal(result.revokedAt, NOW);

  const alreadyRevoked = mockOrganizationInvitationDb({
    invitation: {
      id: "organization-invitation-a",
      acceptedAt: null,
      revokedAt: NOW,
    },
  });
  const repeated = await revokeOrganizationOwnerInvitation(
    {
      actor: { userId: "platform-admin-a" },
      invitationId: "organization-invitation-a",
    },
    { db: alreadyRevoked.db, now: () => NOW }
  );
  assert.equal(repeated.revokedAt, NOW);
  assert.equal(alreadyRevoked.calls.invitationUpdate.length, 0);
});

test("accepted invitation cannot be revoked", async () => {
  const { db, calls } = mockOrganizationInvitationDb({
    invitation: {
      id: "organization-invitation-a",
      acceptedAt: NOW,
      revokedAt: null,
    },
  });

  await assert.rejects(
    revokeOrganizationOwnerInvitation(
      {
        actor: { userId: "platform-admin-a" },
        invitationId: "organization-invitation-a",
      },
      { db, now: () => NOW }
    ),
    (error) =>
      assertInvitationError(
        error,
        "ORGANIZATION_INVITATION_ALREADY_ACCEPTED"
      )
  );
  assert.equal(calls.invitationUpdate.length, 0);
});

test("malformed token is rejected without database reads", async () => {
  const { db, calls } = mockOrganizationInvitationDb();

  await assert.rejects(
    acceptOrganizationOwnerInvitation(
      {
        token: "not-a-valid-token",
        fullName: "Elena Rivera",
        password: "Secure!Pass2026",
      },
      { db, now: () => NOW }
    ),
    (error) =>
      assertInvitationError(
        error,
        "ORGANIZATION_INVITATION_INPUT_INVALID"
      )
  );
  assert.equal(calls.invitationFindUnique.length, 0);
  assert.equal(calls.transactions, 0);
});
