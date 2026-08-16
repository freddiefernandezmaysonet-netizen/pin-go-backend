import assert from "node:assert/strict";
import test from "node:test";
import {
  PIN_GO_STANDARD_BRAND_CONTEXT,
  normalizeBrandHostname,
  resolvePublishedBrandContextByHostname,
  resolvePublishedBrandContextForOrganization,
  type PublishedBrandContextResolverOptions,
} from "./published-brand-context.service.js";

type ResolverDb = NonNullable<PublishedBrandContextResolverOptions["db"]>;

function publishedProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "brand-profile-a",
    organizationId: "organization-a",
    experienceType: "ENTERPRISE_BRANDED",
    status: "ACTIVE",
    activeRevisionId: "brand-revision-a",
    activeDomainId: "brand-domain-a",
    organization: {
      id: "organization-a",
      slug: "organization-a",
    },
    activeRevision: {
      id: "brand-revision-a",
      brandProfileId: "brand-profile-a",
      version: 3,
      displayName: "Casa Azul Management",
      logoUrl: "https://cdn.example.com/brands/casa-azul-logo.png",
      faviconUrl: "https://cdn.example.com/brands/casa-azul-favicon.png",
      primaryColor: "#155EEF",
      approvalStatus: "APPROVED",
    },
    activeDomain: {
      id: "brand-domain-a",
      brandProfileId: "brand-profile-a",
      hostname: "portal.casa-azul.example",
      status: "ACTIVE",
    },
    ...overrides,
  };
}

function mockResolverDb(input: {
  domain?: unknown;
  profile?: unknown;
}) {
  const calls = {
    domain: [] as unknown[],
    profile: [] as unknown[],
  };

  const db = {
    brandDomain: {
      findUnique: async (args: unknown) => {
        calls.domain.push(args);
        return input.domain ?? null;
      },
    },
    brandProfile: {
      findUnique: async (args: unknown) => {
        calls.profile.push(args);
        return input.profile ?? null;
      },
    },
  } as unknown as ResolverDb;

  return { db, calls };
}

test("hostname normalization accepts safe host and optional port", () => {
  assert.equal(
    normalizeBrandHostname(" Portal.Casa-Azul.Example:443 "),
    "portal.casa-azul.example"
  );
  assert.equal(
    normalizeBrandHostname("portal.casa-azul.example."),
    "portal.casa-azul.example"
  );
  assert.equal(normalizeBrandHostname("localhost:5173"), "localhost");
  assert.equal(normalizeBrandHostname("127.0.0.1:5173"), "127.0.0.1");
});

test("hostname normalization rejects ambiguous or unsafe input", () => {
  for (const hostname of [
    "",
    "tenant",
    "https://tenant.example.com",
    "tenant.example.com/path",
    "tenant.example.com, proxy.example.com",
    "user@tenant.example.com",
    "tenant..example.com",
    "-tenant.example.com",
    "tenant.example.com:70000",
  ]) {
    assert.equal(normalizeBrandHostname(hostname), null);
  }
});

test("Pin&Go hostname always returns standard context without database reads", async () => {
  const { db, calls } = mockResolverDb({});

  const result = await resolvePublishedBrandContextByHostname(
    "APP.PIN-NGO.COM:443",
    { db, brandingEnabled: true }
  );

  assert.deepEqual(result, PIN_GO_STANDARD_BRAND_CONTEXT);
  assert.equal(calls.domain.length, 0);
  assert.equal(calls.profile.length, 0);
});

test("disabled feature closes a custom hostname without database reads", async () => {
  const { db, calls } = mockResolverDb({});

  const result = await resolvePublishedBrandContextByHostname(
    "portal.casa-azul.example",
    { db, brandingEnabled: false }
  );

  assert.deepEqual(result, {
    kind: "DOMAIN_UNAVAILABLE",
    hostname: "portal.casa-azul.example",
    reason: "CUSTOM_BRANDING_DISABLED",
    poweredByPinGo: true,
  });
  assert.equal(calls.domain.length, 0);
  assert.equal(calls.profile.length, 0);
});

test("unknown custom hostname never falls back to another brand", async () => {
  const { db, calls } = mockResolverDb({});

  const result = await resolvePublishedBrandContextByHostname(
    "unknown.example.com",
    { db, brandingEnabled: true }
  );

  assert.equal(result.kind, "DOMAIN_UNAVAILABLE");
  if (result.kind !== "DOMAIN_UNAVAILABLE") return;
  assert.equal(result.reason, "DOMAIN_NOT_FOUND");
  assert.equal(calls.domain.length, 1);
  assert.equal(calls.profile.length, 0);
});

test("domain must be active before its profile can be resolved", async () => {
  const { db, calls } = mockResolverDb({
    domain: { id: "brand-domain-a", status: "VERIFYING" },
    profile: publishedProfile(),
  });

  const result = await resolvePublishedBrandContextByHostname(
    "portal.casa-azul.example",
    { db, brandingEnabled: true }
  );

  assert.equal(result.kind, "DOMAIN_UNAVAILABLE");
  if (result.kind !== "DOMAIN_UNAVAILABLE") return;
  assert.equal(result.reason, "DOMAIN_NOT_ACTIVE");
  assert.equal(calls.profile.length, 0);
});

test("active domain resolves its exact approved brand", async () => {
  const { db, calls } = mockResolverDb({
    domain: { id: "brand-domain-a", status: "ACTIVE" },
    profile: publishedProfile(),
  });

  const result = await resolvePublishedBrandContextByHostname(
    "portal.casa-azul.example",
    { db, brandingEnabled: true }
  );

  assert.deepEqual(result, {
    kind: "CUSTOM_BRAND",
    displayName: "Casa Azul Management",
    logoUrl: "https://cdn.example.com/brands/casa-azul-logo.png",
    faviconUrl: "https://cdn.example.com/brands/casa-azul-favicon.png",
    primaryColor: "#155EEF",
    onPrimaryColor: "#FFFFFF",
    organizationId: "organization-a",
    organizationSlug: "organization-a",
    revisionId: "brand-revision-a",
    version: 3,
    customDomain: "portal.casa-azul.example",
    poweredByPinGo: true,
  });
  assert.equal(calls.domain.length, 1);
  assert.equal(calls.profile.length, 1);
  const profileCall = calls.profile[0] as {
    where?: unknown;
    select?: unknown;
  };
  assert.deepEqual(profileCall.where, { activeDomainId: "brand-domain-a" });
  assert.ok(profileCall.select);
});

test("hostname cannot use a profile whose active domain is different", async () => {
  const { db } = mockResolverDb({
    domain: { id: "brand-domain-a", status: "ACTIVE" },
    profile: publishedProfile({
      activeDomain: {
        id: "brand-domain-b",
        brandProfileId: "brand-profile-a",
        hostname: "other.example.com",
        status: "ACTIVE",
      },
    }),
  });

  const result = await resolvePublishedBrandContextByHostname(
    "portal.casa-azul.example",
    { db, brandingEnabled: true }
  );

  assert.equal(result.kind, "DOMAIN_UNAVAILABLE");
  if (result.kind !== "DOMAIN_UNAVAILABLE") return;
  assert.equal(result.reason, "ACTIVE_DOMAIN_MISMATCH");
});

test("inactive or standard profile cannot publish a custom identity", async () => {
  for (const profile of [
    publishedProfile({ status: "SUSPENDED" }),
    publishedProfile({ experienceType: "STANDARD" }),
  ]) {
    const { db } = mockResolverDb({
      domain: { id: "brand-domain-a", status: "ACTIVE" },
      profile,
    });

    const result = await resolvePublishedBrandContextByHostname(
      "portal.casa-azul.example",
      { db, brandingEnabled: true }
    );

    assert.equal(result.kind, "DOMAIN_UNAVAILABLE");
  }
});

test("revision must be approved and belong to the active profile", async () => {
  const cases = [
    {
      revision: {
        ...publishedProfile().activeRevision,
        approvalStatus: "PENDING_APPROVAL",
      },
      reason: "REVISION_NOT_PUBLISHED",
    },
    {
      revision: {
        ...publishedProfile().activeRevision,
        brandProfileId: "brand-profile-b",
      },
      reason: "REVISION_PROFILE_MISMATCH",
    },
  ] as const;

  for (const item of cases) {
    const { db } = mockResolverDb({
      domain: { id: "brand-domain-a", status: "ACTIVE" },
      profile: publishedProfile({ activeRevision: item.revision }),
    });

    const result = await resolvePublishedBrandContextByHostname(
      "portal.casa-azul.example",
      { db, brandingEnabled: true }
    );

    assert.equal(result.kind, "DOMAIN_UNAVAILABLE");
    if (result.kind !== "DOMAIN_UNAVAILABLE") continue;
    assert.equal(result.reason, item.reason);
  }
});

test("invalid published assets fail closed", async () => {
  const { db } = mockResolverDb({
    domain: { id: "brand-domain-a", status: "ACTIVE" },
    profile: publishedProfile({
      activeRevision: {
        ...publishedProfile().activeRevision,
        logoUrl: "http://cdn.example.com/logo.png",
      },
    }),
  });

  const result = await resolvePublishedBrandContextByHostname(
    "portal.casa-azul.example",
    { db, brandingEnabled: true }
  );

  assert.equal(result.kind, "DOMAIN_UNAVAILABLE");
  if (result.kind !== "DOMAIN_UNAVAILABLE") return;
  assert.equal(result.reason, "BRAND_IDENTITY_INVALID");
});

test("organization resolver returns custom context only for a valid profile", async () => {
  const { db, calls } = mockResolverDb({ profile: publishedProfile() });

  const result = await resolvePublishedBrandContextForOrganization(
    "  organization-a  ",
    { db, brandingEnabled: true }
  );

  assert.equal(result.kind, "CUSTOM_BRAND");
  const profileCall = calls.profile[0] as {
    where?: unknown;
    select?: unknown;
  };
  assert.deepEqual(profileCall.where, { organizationId: "organization-a" });
  assert.ok(profileCall.select);
});

test("organization resolver safely falls back to Pin&Go", async () => {
  const { db, calls } = mockResolverDb({
    profile: publishedProfile({ status: "SUSPENDED" }),
  });

  assert.deepEqual(
    await resolvePublishedBrandContextForOrganization("organization-a", {
      db,
      brandingEnabled: false,
    }),
    PIN_GO_STANDARD_BRAND_CONTEXT
  );
  assert.equal(calls.profile.length, 0);

  assert.deepEqual(
    await resolvePublishedBrandContextForOrganization("organization-a", {
      db,
      brandingEnabled: true,
    }),
    PIN_GO_STANDARD_BRAND_CONTEXT
  );
});
