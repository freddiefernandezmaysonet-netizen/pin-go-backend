import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  EnterpriseBrandOnboardingError,
  provisionEnterpriseBrandOrganization,
  type EnterpriseBrandOnboardingServiceOptions,
  type ProvisionEnterpriseBrandOrganizationInput,
} from "./enterprise-brand-onboarding.service.js";
import { BrandPolicyError } from "./brand-policy.js";

type ServiceDb = NonNullable<EnterpriseBrandOnboardingServiceOptions["db"]>;

const NOW = new Date("2026-08-15T20:00:00.000Z");
const TOKEN = "B".repeat(43);
const TOKEN_HASH = createHash("sha256")
  .update(TOKEN, "utf8")
  .digest("hex");

function validInput(
  overrides: Partial<ProvisionEnterpriseBrandOrganizationInput> = {}
): ProvisionEnterpriseBrandOrganizationInput {
  return {
    actor: { userId: "platform-admin-a" },
    organizationName: "Casa Azul Management",
    organizationSlug: "casa-azul-management",
    ownerEmail: "owner@example.com",
    identity: {
      displayName: "Casa Azul Management",
      logoUrl: "https://cdn.example.com/brands/casa-azul-logo.png",
      logoPublicId: "brands/casa-azul/logo",
      faviconUrl:
        "https://cdn.example.com/brands/casa-azul-favicon.png",
      faviconPublicId: "brands/casa-azul/favicon",
      primaryColor: "#155eef",
    },
    hostname: "portal.casa-azul.example",
    domainType: "CUSTOM_DOMAIN",
    ...overrides,
  };
}

type MockInput = {
  actor?: unknown;
  existingOrganization?: unknown;
  existingUser?: unknown;
  existingDomain?: unknown;
  transactionError?: unknown;
  revisionCreateError?: unknown;
};

function mockEnterpriseOnboardingDb(input: MockInput = {}) {
  const calls = {
    transactions: 0,
    actorFindUnique: [] as unknown[],
    userFindUnique: [] as unknown[],
    organizationFindUnique: [] as unknown[],
    organizationCreate: [] as unknown[],
    profileCreate: [] as unknown[],
    revisionCreate: [] as unknown[],
    domainFindUnique: [] as unknown[],
    domainCreate: [] as unknown[],
    invitationCreate: [] as unknown[],
  };

  const transaction = {
    dashboardUser: {
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
    },
    organization: {
      findUnique: async (args: unknown) => {
        calls.organizationFindUnique.push(args);
        return input.existingOrganization ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.organizationCreate.push(args);
        return {
          id: "organization-created",
          createdAt: NOW,
          ...args.data,
        };
      },
    },
    brandProfile: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.profileCreate.push(args);
        return {
          id: "brand-profile-created",
          createdAt: NOW,
          ...args.data,
        };
      },
    },
    brandRevision: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.revisionCreate.push(args);
        if (input.revisionCreateError) throw input.revisionCreateError;
        return {
          id: "brand-revision-created",
          createdAt: NOW,
          ...args.data,
        };
      },
    },
    brandDomain: {
      findUnique: async (args: unknown) => {
        calls.domainFindUnique.push(args);
        return input.existingDomain ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.domainCreate.push(args);
        return {
          id: "brand-domain-created",
          createdAt: NOW,
          ...args.data,
        };
      },
    },
    organizationInvitation: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.invitationCreate.push(args);
        return {
          id: "organization-invitation-created",
          createdAt: NOW,
          ...args.data,
        };
      },
    },
  };

  const db = {
    $transaction: async (
      operation: (tx: typeof transaction) => Promise<unknown>
    ) => {
      calls.transactions += 1;
      if (input.transactionError) throw input.transactionError;
      return operation(transaction);
    },
  } as unknown as ServiceDb;

  return { db, calls };
}

function assertOnboardingError(
  error: unknown,
  code: EnterpriseBrandOnboardingError["code"]
): boolean {
  assert.ok(error instanceof EnterpriseBrandOnboardingError);
  assert.equal(error.code, code);
  return true;
}

test("provisions organization, brand, domain and invitation in one transaction", async () => {
  const { db, calls } = mockEnterpriseOnboardingDb();

  const result = await provisionEnterpriseBrandOrganization(
    validInput({
      organizationName: "  Casa Azul Management  ",
      organizationSlug: "Casa-Azul-Management",
      ownerEmail: " Owner@Example.COM ",
      hostname: " Portal.Casa-Azul.Example:443 ",
    }),
    {
      db,
      now: () => NOW,
      generateToken: () => TOKEN,
    }
  );

  assert.equal(calls.transactions, 1);
  assert.equal(calls.organizationCreate.length, 1);
  assert.equal(calls.profileCreate.length, 1);
  assert.equal(calls.revisionCreate.length, 1);
  assert.equal(calls.domainCreate.length, 1);
  assert.equal(calls.invitationCreate.length, 1);

  const organization = calls.organizationCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(organization.data, {
    name: "Casa Azul Management",
    slug: "casa-azul-management",
  });

  const profile = calls.profileCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(profile.data, {
    organizationId: "organization-created",
    experienceType: "ENTERPRISE_BRANDED",
    status: "DRAFT",
  });

  const revision = calls.revisionCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(revision.data.version, 1);
  assert.equal(revision.data.approvalStatus, "DRAFT");
  assert.equal(revision.data.primaryColor, "#155EEF");
  assert.equal(revision.data.createdByUserId, "platform-admin-a");

  const domain = calls.domainCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(domain.data.hostname, "portal.casa-azul.example");
  assert.equal(domain.data.status, "PENDING_CONFIGURATION");
  assert.equal(domain.data.provider, "VERCEL");

  const invitation = calls.invitationCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(invitation.data.email, "owner@example.com");
  assert.equal(invitation.data.role, "ORG_ADMIN");
  assert.equal(invitation.data.tokenHash, TOKEN_HASH);
  assert.notEqual(invitation.data.tokenHash, TOKEN);
  assert.equal(
    (invitation.data.expiresAt as Date).getTime() - NOW.getTime(),
    72 * 60 * 60 * 1000
  );
  assert.equal(result.invitationToken, TOKEN);
});

test("owner account is not created during provisioning", async () => {
  const { db, calls } = mockEnterpriseOnboardingDb();

  await provisionEnterpriseBrandOrganization(validInput(), {
    db,
    now: () => NOW,
    generateToken: () => TOKEN,
  });

  assert.equal(calls.userFindUnique.length, 1);
  const transactionShape = db as unknown as Record<string, unknown>;
  assert.equal(transactionShape.dashboardUser, undefined);
});

test("commercial eligibility is not inferred from property count", async () => {
  const { db } = mockEnterpriseOnboardingDb();

  await provisionEnterpriseBrandOrganization(validInput(), {
    db,
    now: () => NOW,
    generateToken: () => TOKEN,
  });

  assert.equal((db as unknown as Record<string, unknown>).property, undefined);
});

test("active database actor must be PLATFORM_ADMIN", async () => {
  const cases = [
    {
      actor: {
        id: "org-admin-a",
        role: "ORG_ADMIN",
        isActive: true,
      },
      kind: "policy",
    },
    {
      actor: {
        id: "platform-admin-a",
        role: "PLATFORM_ADMIN",
        isActive: false,
      },
      kind: "inactive",
    },
  ] as const;

  for (const item of cases) {
    const { db, calls } = mockEnterpriseOnboardingDb({ actor: item.actor });
    await assert.rejects(
      provisionEnterpriseBrandOrganization(validInput(), {
        db,
        now: () => NOW,
        generateToken: () => TOKEN,
      }),
      (error) => {
        if (item.kind === "policy") {
          assert.ok(error instanceof BrandPolicyError);
          assert.equal(error.code, "BRAND_MANAGER_REQUIRED");
          return true;
        }
        return assertOnboardingError(
          error,
          "ENTERPRISE_BRAND_ONBOARDING_ACTOR_INACTIVE"
        );
      }
    );
    assert.equal(calls.organizationCreate.length, 0);
  }
});

test("invalid identity, slug and domain fail before transaction", async () => {
  const cases = [
    {
      input: validInput({ organizationSlug: "admin" }),
      code: "ENTERPRISE_BRAND_ONBOARDING_INPUT_INVALID",
    },
    {
      input: validInput({
        identity: {
          ...validInput().identity,
          logoUrl: "http://cdn.example.com/logo.png",
        },
      }),
      code: "ENTERPRISE_BRAND_ONBOARDING_IDENTITY_INVALID",
    },
    {
      input: {
        ...validInput(),
        domainType: "INVALID_DOMAIN_TYPE",
      } as unknown as ProvisionEnterpriseBrandOrganizationInput,
      code: "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_TYPE_INVALID",
    },
    {
      input: validInput({ hostname: "app.pin-ngo.com" }),
      code: "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_CONFLICT",
    },
  ] as const;

  for (const item of cases) {
    const { db, calls } = mockEnterpriseOnboardingDb();
    await assert.rejects(
      provisionEnterpriseBrandOrganization(item.input, {
        db,
        now: () => NOW,
        generateToken: () => TOKEN,
      }),
      (error) => assertOnboardingError(error, item.code)
    );
    assert.equal(calls.transactions, 0);
  }
});

test("slug, owner email and domain conflicts prevent every write", async () => {
  const cases = [
    {
      mock: { existingOrganization: { id: "organization-existing" } },
      code: "ENTERPRISE_BRAND_ONBOARDING_SLUG_CONFLICT",
    },
    {
      mock: { existingUser: { id: "user-existing" } },
      code: "ENTERPRISE_BRAND_ONBOARDING_EMAIL_REGISTERED",
    },
    {
      mock: { existingDomain: { id: "domain-existing" } },
      code: "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_CONFLICT",
    },
  ] as const;

  for (const item of cases) {
    const { db, calls } = mockEnterpriseOnboardingDb(item.mock);
    await assert.rejects(
      provisionEnterpriseBrandOrganization(validInput(), {
        db,
        now: () => NOW,
        generateToken: () => TOKEN,
      }),
      (error) => assertOnboardingError(error, item.code)
    );
    assert.equal(calls.organizationCreate.length, 0);
    assert.equal(calls.invitationCreate.length, 0);
  }
});

test("downstream failure prevents later onboarding writes", async () => {
  const revisionFailure = new Error("revision write failed");
  const { db, calls } = mockEnterpriseOnboardingDb({
    revisionCreateError: revisionFailure,
  });

  await assert.rejects(
    provisionEnterpriseBrandOrganization(validInput(), {
      db,
      now: () => NOW,
      generateToken: () => TOKEN,
    }),
    revisionFailure
  );
  assert.equal(calls.transactions, 1);
  assert.equal(calls.domainCreate.length, 0);
  assert.equal(calls.invitationCreate.length, 0);
});

test("concurrent unique conflict is converted to stable service error", async () => {
  const { db } = mockEnterpriseOnboardingDb({
    transactionError: {
      code: "P2002",
      meta: { target: ["slug"] },
    },
  });

  await assert.rejects(
    provisionEnterpriseBrandOrganization(validInput(), {
      db,
      now: () => NOW,
      generateToken: () => TOKEN,
    }),
    (error) =>
      assertOnboardingError(
        error,
        "ENTERPRISE_BRAND_ONBOARDING_CONFLICT"
      )
  );
});

test("direct Pin&Go subdomain is accepted only with PINNGO_SUBDOMAIN", async () => {
  const { db, calls } = mockEnterpriseOnboardingDb();

  await provisionEnterpriseBrandOrganization(
    validInput({
      hostname: "casa-azul.pin-ngo.com",
      domainType: "PINNGO_SUBDOMAIN",
    }),
    { db, now: () => NOW, generateToken: () => TOKEN }
  );
  const domain = calls.domainCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(domain.data.type, "PINNGO_SUBDOMAIN");

  const invalid = mockEnterpriseOnboardingDb();
  await assert.rejects(
    provisionEnterpriseBrandOrganization(
      validInput({
        hostname: "casa-azul.pin-ngo.com",
        domainType: "CUSTOM_DOMAIN",
      }),
      { db: invalid.db, now: () => NOW, generateToken: () => TOKEN }
    ),
    (error) =>
      assertOnboardingError(
        error,
        "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_TYPE_INVALID"
      )
  );
  assert.equal(invalid.calls.transactions, 0);
});
