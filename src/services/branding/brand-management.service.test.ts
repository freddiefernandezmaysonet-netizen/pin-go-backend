import assert from "node:assert/strict";
import test from "node:test";
import {
  BrandManagementError,
  createBrandRevisionDraft,
  initializeEnterpriseBrand,
  publishEnterpriseBrand,
  registerBrandDomain,
  suspendEnterpriseBrand,
  transitionBrandDomain,
  type BrandIdentityInput,
  type BrandManagementServiceOptions,
} from "./brand-management.service.js";
import { BrandPolicyError } from "./brand-policy.js";

type ServiceDb = NonNullable<BrandManagementServiceOptions["db"]>;

const IDENTITY: BrandIdentityInput = {
  displayName: "Casa Azul Management",
  logoUrl: "https://cdn.example.com/brands/casa-azul-logo.png",
  logoPublicId: "brands/casa-azul/logo",
  faviconUrl: "https://cdn.example.com/brands/casa-azul-favicon.png",
  faviconPublicId: "brands/casa-azul/favicon",
  primaryColor: "#155eef",
};

const ENTERPRISE_PROFILE = {
  id: "brand-profile-a",
  organizationId: "organization-a",
  experienceType: "ENTERPRISE_BRANDED",
  status: "DRAFT",
  activeRevisionId: null,
  activeDomainId: null,
};

type MockOverrides = {
  actor?: unknown;
  organization?: unknown;
  profile?: unknown;
  latestRevision?: unknown;
  revision?: unknown;
  domain?: unknown;
};

function mockBrandManagementDb(overrides: MockOverrides = {}) {
  const calls = {
    transactions: 0,
    organizationFindUnique: [] as unknown[],
    profileFindUnique: [] as unknown[],
    profileCreate: [] as unknown[],
    profileUpdate: [] as unknown[],
    revisionFindFirst: [] as unknown[],
    revisionFindUnique: [] as unknown[],
    revisionCreate: [] as unknown[],
    domainFindUnique: [] as unknown[],
    domainCreate: [] as unknown[],
    domainUpdate: [] as unknown[],
  };

  const transaction = {
    dashboardUser: {
      findUnique: async () =>
        overrides.actor === undefined
          ? {
              id: "platform-admin-a",
              role: "PLATFORM_ADMIN",
              isActive: true,
            }
          : overrides.actor,
    },
    organization: {
      findUnique: async (args: unknown) => {
        calls.organizationFindUnique.push(args);
        return overrides.organization === undefined
          ? { id: "organization-a" }
          : overrides.organization;
      },
    },
    brandProfile: {
      findUnique: async (args: unknown) => {
        calls.profileFindUnique.push(args);
        return overrides.profile === undefined ? null : overrides.profile;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.profileCreate.push(args);
        return {
          id: "brand-profile-a",
          ...args.data,
        };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        calls.profileUpdate.push(args);
        return {
          ...ENTERPRISE_PROFILE,
          ...args.data,
        };
      },
    },
    brandRevision: {
      findFirst: async (args: unknown) => {
        calls.revisionFindFirst.push(args);
        return overrides.latestRevision ?? null;
      },
      findUnique: async (args: unknown) => {
        calls.revisionFindUnique.push(args);
        return overrides.revision ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.revisionCreate.push(args);
        return {
          id: "brand-revision-created",
          ...args.data,
        };
      },
    },
    brandDomain: {
      findUnique: async (args: unknown) => {
        calls.domainFindUnique.push(args);
        return overrides.domain ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.domainCreate.push(args);
        return {
          id: "brand-domain-created",
          ...args.data,
        };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        calls.domainUpdate.push(args);
        return {
          id: "brand-domain-a",
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
      return operation(transaction);
    },
  } as unknown as ServiceDb;

  return { db, calls };
}

function managerInput() {
  return {
    actor: { userId: "platform-admin-a" },
  };
}

function assertManagementError(
  error: unknown,
  code: BrandManagementError["code"]
): boolean {
  assert.ok(error instanceof BrandManagementError);
  assert.equal(error.code, code);
  return true;
}

function assertPolicyError(
  error: unknown,
  code: BrandPolicyError["code"]
): boolean {
  assert.ok(error instanceof BrandPolicyError);
  assert.equal(error.code, code);
  return true;
}

test("initialization creates enterprise profile, revision V1 and pending domain atomically", async () => {
  const { db, calls } = mockBrandManagementDb();

  const result = await initializeEnterpriseBrand(
    {
      ...managerInput(),
      organizationId: " organization-a ",
      identity: IDENTITY,
      hostname: " Portal.Casa-Azul.Example:443 ",
      domainType: "CUSTOM_DOMAIN",
    },
    { db }
  );

  assert.equal(calls.transactions, 1);
  assert.equal(calls.organizationFindUnique.length, 1);
  assert.equal(calls.profileCreate.length, 1);
  assert.equal(calls.revisionCreate.length, 1);
  assert.equal(calls.domainCreate.length, 1);

  const profileCreate = calls.profileCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(profileCreate.data, {
    organizationId: "organization-a",
    experienceType: "ENTERPRISE_BRANDED",
    status: "DRAFT",
  });

  const revisionCreate = calls.revisionCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(revisionCreate.data.version, 1);
  assert.equal(revisionCreate.data.approvalStatus, "DRAFT");
  assert.equal(revisionCreate.data.primaryColor, "#155EEF");
  assert.equal(revisionCreate.data.createdByUserId, "platform-admin-a");

  const domainCreate = calls.domainCreate[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(domainCreate.data.hostname, "portal.casa-azul.example");
  assert.equal(domainCreate.data.status, "PENDING_CONFIGURATION");
  assert.equal(domainCreate.data.provider, "VERCEL");
  assert.equal(result.profile.id, "brand-profile-a");
});

test("initialization does not infer eligibility from property count", async () => {
  const { db } = mockBrandManagementDb();

  await initializeEnterpriseBrand(
    {
      ...managerInput(),
      organizationId: "organization-a",
      identity: IDENTITY,
      hostname: "portal.casa-azul.example",
      domainType: "CUSTOM_DOMAIN",
    },
    { db }
  );

  const mock = db as unknown as Record<string, unknown>;
  assert.equal(mock.property, undefined);
});

test("database role must be active PLATFORM_ADMIN", async () => {
  for (const item of [
    {
      actor: {
        id: "org-admin-a",
        role: "ORG_ADMIN",
        isActive: true,
      },
      expected: "BRAND_MANAGER_REQUIRED",
    },
    {
      actor: {
        id: "platform-admin-a",
        role: "PLATFORM_ADMIN",
        isActive: false,
      },
      expected: "BRAND_MANAGEMENT_ACTOR_INACTIVE",
    },
  ] as const) {
    const { db } = mockBrandManagementDb({ actor: item.actor });
    await assert.rejects(
      initializeEnterpriseBrand(
        {
          ...managerInput(),
          organizationId: "organization-a",
          identity: IDENTITY,
          hostname: "portal.casa-azul.example",
          domainType: "CUSTOM_DOMAIN",
        },
        { db }
      ),
      (error) =>
        item.expected === "BRAND_MANAGER_REQUIRED"
          ? assertPolicyError(error, item.expected)
          : assertManagementError(error, item.expected)
    );
  }
});

test("missing organization and existing profile fail closed", async () => {
  const cases = [
    {
      overrides: { organization: null },
      code: "BRAND_MANAGEMENT_ORGANIZATION_NOT_FOUND",
    },
    {
      overrides: { profile: { id: "existing-profile" } },
      code: "BRAND_MANAGEMENT_PROFILE_ALREADY_EXISTS",
    },
  ] as const;

  for (const item of cases) {
    const { db } = mockBrandManagementDb(item.overrides);
    await assert.rejects(
      initializeEnterpriseBrand(
        {
          ...managerInput(),
          organizationId: "organization-a",
          identity: IDENTITY,
          hostname: "portal.casa-azul.example",
          domainType: "CUSTOM_DOMAIN",
        },
        { db }
      ),
      (error) => assertManagementError(error, item.code)
    );
  }
});

test("identity and reserved hostname are rejected before a transaction", async () => {
  const invalidCases = [
    {
      identity: { ...IDENTITY, logoUrl: "http://cdn.example.com/logo.png" },
      hostname: "portal.casa-azul.example",
      code: "BRAND_MANAGEMENT_IDENTITY_INVALID",
    },
    {
      identity: IDENTITY,
      hostname: "app.pin-ngo.com",
      code: "BRAND_MANAGEMENT_DOMAIN_CONFLICT",
    },
  ] as const;

  for (const item of invalidCases) {
    const { db, calls } = mockBrandManagementDb();
    await assert.rejects(
      initializeEnterpriseBrand(
        {
          ...managerInput(),
          organizationId: "organization-a",
          identity: item.identity,
          hostname: item.hostname,
          domainType: "CUSTOM_DOMAIN",
        },
        { db }
      ),
      (error) => assertManagementError(error, item.code)
    );
    assert.equal(calls.transactions, 0);
  }
});

test("new revision is immutable and receives the next profile version", async () => {
  const { db, calls } = mockBrandManagementDb({
    profile: ENTERPRISE_PROFILE,
    latestRevision: { version: 4 },
  });

  const result = await createBrandRevisionDraft(
    {
      ...managerInput(),
      brandProfileId: "brand-profile-a",
      identity: { ...IDENTITY, displayName: "Casa Azul V5" },
    },
    { db }
  );

  assert.equal(calls.revisionFindFirst.length, 1);
  assert.equal(calls.revisionCreate.length, 1);
  assert.equal(calls.profileUpdate.length, 0);
  assert.equal(result.version, 5);
  assert.equal(result.approvalStatus, "DRAFT");
});

test("domain registration enforces profile ownership and hostname type", async () => {
  const { db, calls } = mockBrandManagementDb({
    profile: ENTERPRISE_PROFILE,
  });

  const result = await registerBrandDomain(
    {
      ...managerInput(),
      brandProfileId: "brand-profile-a",
      hostname: "casa-azul.pin-ngo.com",
      domainType: "PINNGO_SUBDOMAIN",
    },
    { db }
  );

  assert.equal(result.hostname, "casa-azul.pin-ngo.com");
  assert.equal(result.type, "PINNGO_SUBDOMAIN");
  assert.equal(calls.domainCreate.length, 1);

  const invalid = mockBrandManagementDb({ profile: ENTERPRISE_PROFILE });
  await assert.rejects(
    registerBrandDomain(
      {
        ...managerInput(),
        brandProfileId: "brand-profile-a",
        hostname: "nested.casa-azul.pin-ngo.com",
        domainType: "PINNGO_SUBDOMAIN",
      },
      { db: invalid.db }
    ),
    (error) =>
      assertManagementError(
        error,
        "BRAND_MANAGEMENT_DOMAIN_TYPE_INVALID"
      )
  );
  assert.equal(invalid.calls.transactions, 0);
});

test("domain transition records activation lifecycle timestamps", async () => {
  const activatedAt = new Date("2026-08-15T20:00:00.000Z");
  const { db, calls } = mockBrandManagementDb({
    profile: ENTERPRISE_PROFILE,
    domain: {
      id: "brand-domain-a",
      brandProfileId: "brand-profile-a",
      status: "VERIFYING",
      verifiedAt: null,
      activatedAt: null,
    },
  });

  await transitionBrandDomain(
    {
      ...managerInput(),
      brandProfileId: "brand-profile-a",
      brandDomainId: "brand-domain-a",
      toStatus: "ACTIVE",
      providerDomainId: "vercel-domain-a",
    },
    { db, now: () => activatedAt }
  );

  const update = calls.domainUpdate[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(update.data.status, "ACTIVE");
  assert.equal(update.data.providerDomainId, "vercel-domain-a");
  assert.equal(update.data.verifiedAt, activatedAt);
  assert.equal(update.data.activatedAt, activatedAt);
});

test("invalid domain transition never writes", async () => {
  const { db, calls } = mockBrandManagementDb({
    profile: ENTERPRISE_PROFILE,
    domain: {
      id: "brand-domain-a",
      brandProfileId: "brand-profile-a",
      status: "ACTIVE",
      verifiedAt: new Date(),
      activatedAt: new Date(),
    },
  });

  await assert.rejects(
    transitionBrandDomain(
      {
        ...managerInput(),
        brandProfileId: "brand-profile-a",
        brandDomainId: "brand-domain-a",
        toStatus: "PENDING_DNS",
      },
      { db }
    ),
    (error) =>
      assertPolicyError(error, "BRAND_DOMAIN_TRANSITION_INVALID")
  );
  assert.equal(calls.domainUpdate.length, 0);
});

test("domain from another profile is isolated", async () => {
  const { db, calls } = mockBrandManagementDb({
    profile: ENTERPRISE_PROFILE,
    domain: {
      id: "brand-domain-b",
      brandProfileId: "brand-profile-b",
      status: "VERIFYING",
      verifiedAt: null,
      activatedAt: null,
    },
  });

  await assert.rejects(
    transitionBrandDomain(
      {
        ...managerInput(),
        brandProfileId: "brand-profile-a",
        brandDomainId: "brand-domain-b",
        toStatus: "ACTIVE",
      },
      { db }
    ),
    (error) =>
      assertManagementError(error, "BRAND_MANAGEMENT_DOMAIN_NOT_FOUND")
  );
  assert.equal(calls.domainUpdate.length, 0);
});

test("publication atomically selects exact approved revision and active domain", async () => {
  const { db, calls } = mockBrandManagementDb({
    profile: ENTERPRISE_PROFILE,
    revision: {
      id: "brand-revision-a",
      brandProfileId: "brand-profile-a",
      displayName: IDENTITY.displayName,
      logoUrl: IDENTITY.logoUrl,
      faviconUrl: IDENTITY.faviconUrl,
      primaryColor: "#155EEF",
      approvalStatus: "APPROVED",
    },
    domain: {
      id: "brand-domain-a",
      brandProfileId: "brand-profile-a",
      status: "ACTIVE",
    },
  });

  const result = await publishEnterpriseBrand(
    {
      ...managerInput(),
      brandProfileId: "brand-profile-a",
      brandRevisionId: "brand-revision-a",
      brandDomainId: "brand-domain-a",
    },
    { db }
  );

  assert.equal(calls.transactions, 1);
  assert.equal(calls.profileUpdate.length, 1);
  const update = calls.profileUpdate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(update.data, {
    status: "ACTIVE",
    activeRevisionId: "brand-revision-a",
    activeDomainId: "brand-domain-a",
  });
  assert.equal(result.publishedByUserId, "platform-admin-a");
});

test("publication fails closed for unapproved or cross-profile records", async () => {
  const cases = [
    {
      revisionProfileId: "brand-profile-a",
      approvalStatus: "PENDING_APPROVAL",
      domainProfileId: "brand-profile-a",
    },
    {
      revisionProfileId: "brand-profile-b",
      approvalStatus: "APPROVED",
      domainProfileId: "brand-profile-a",
    },
    {
      revisionProfileId: "brand-profile-a",
      approvalStatus: "APPROVED",
      domainProfileId: "brand-profile-b",
    },
  ] as const;

  for (const item of cases) {
    const { db, calls } = mockBrandManagementDb({
      profile: ENTERPRISE_PROFILE,
      revision: {
        id: "brand-revision-a",
        brandProfileId: item.revisionProfileId,
        displayName: IDENTITY.displayName,
        logoUrl: IDENTITY.logoUrl,
        faviconUrl: IDENTITY.faviconUrl,
        primaryColor: "#155EEF",
        approvalStatus: item.approvalStatus,
      },
      domain: {
        id: "brand-domain-a",
        brandProfileId: item.domainProfileId,
        status: "ACTIVE",
      },
    });

    await assert.rejects(
      publishEnterpriseBrand(
        {
          ...managerInput(),
          brandProfileId: "brand-profile-a",
          brandRevisionId: "brand-revision-a",
          brandDomainId: "brand-domain-a",
        },
        { db }
      ),
      (error) =>
        assertPolicyError(error, "BRAND_PUBLICATION_NOT_READY")
    );
    assert.equal(calls.profileUpdate.length, 0);
  }
});

test("suspension preserves published pointers and closes through profile status", async () => {
  const { db, calls } = mockBrandManagementDb({
    profile: {
      ...ENTERPRISE_PROFILE,
      status: "ACTIVE",
      activeRevisionId: "brand-revision-a",
      activeDomainId: "brand-domain-a",
    },
  });

  await suspendEnterpriseBrand(
    {
      ...managerInput(),
      brandProfileId: "brand-profile-a",
    },
    { db }
  );

  const update = calls.profileUpdate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(update.data, { status: "SUSPENDED" });
});
