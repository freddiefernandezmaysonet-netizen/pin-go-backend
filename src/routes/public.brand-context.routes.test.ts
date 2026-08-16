import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { prisma } from "../lib/prisma.js";
import { publicBrandContextRouter } from "./public.brand-context.routes.js";

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

type MutablePrisma = {
  brandDomain: {
    findUnique: (...args: unknown[]) => Promise<unknown>;
  };
  brandProfile: {
    findUnique: (...args: unknown[]) => Promise<unknown>;
  };
};

const mutablePrisma = prisma as unknown as MutablePrisma;

function publishedProfile() {
  return {
    id: "brand-profile-a",
    organizationId: "organization-a",
    experienceType: "ENTERPRISE_BRANDED",
    status: "ACTIVE",
    activeRevisionId: "brand-revision-a",
    activeDomainId: "brand-domain-a",
    organization: {
      id: "organization-a",
      slug: "casa-azul",
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

async function requestRoute(input: {
  host: string;
  forwardedHost?: string;
  brandHostname?: string;
  path?: string;
}): Promise<Response> {
  const app = express();
  app.set("trust proxy", 1);
  app.use(publicBrandContextRouter);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${input.path ?? "/api/public/brand-context"}`,
      {
        method: "GET",
        headers: {
          Host: input.host,
          Connection: "close",
          ...(input.forwardedHost
            ? { "X-Forwarded-Host": input.forwardedHost }
            : {}),
          ...(input.brandHostname
            ? { "X-Pin-Go-Brand-Hostname": input.brandHostname }
            : {}),
        },
      }
    );
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

async function withBrandResolverStubs<T>(
  input: {
    enabled: boolean;
    domainFindUnique?: (...args: unknown[]) => Promise<unknown>;
    profileFindUnique?: (...args: unknown[]) => Promise<unknown>;
  },
  action: () => Promise<T>
): Promise<T> {
  const originalFlag = process.env.CUSTOM_BRANDING_V1_ENABLED;
  const originalDomainFindUnique = mutablePrisma.brandDomain.findUnique;
  const originalProfileFindUnique = mutablePrisma.brandProfile.findUnique;

  process.env.CUSTOM_BRANDING_V1_ENABLED = input.enabled
    ? "true"
    : "false";
  if (input.domainFindUnique) {
    mutablePrisma.brandDomain.findUnique = input.domainFindUnique;
  }
  if (input.profileFindUnique) {
    mutablePrisma.brandProfile.findUnique = input.profileFindUnique;
  }

  try {
    return await action();
  } finally {
    if (originalFlag === undefined) {
      delete process.env.CUSTOM_BRANDING_V1_ENABLED;
    } else {
      process.env.CUSTOM_BRANDING_V1_ENABLED = originalFlag;
    }
    mutablePrisma.brandDomain.findUnique = originalDomainFindUnique;
    mutablePrisma.brandProfile.findUnique = originalProfileFindUnique;
  }
}

test("router exposes only the public hostname context endpoint", () => {
  const layers = (
    publicBrandContextRouter as unknown as { stack: RouterLayer[] }
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

  assert.deepEqual(surface, ["GET /api/public/brand-context"]);
});

test("app.pin-ngo.com always returns standard Pin&Go without database reads", async () => {
  let databaseReads = 0;

  await withBrandResolverStubs(
    {
      enabled: true,
      domainFindUnique: async () => {
        databaseReads += 1;
        return null;
      },
      profileFindUnique: async () => {
        databaseReads += 1;
        return null;
      },
    },
    async () => {
      const response = await requestRoute({
        host: "api.pin-ngo.com",
        forwardedHost: "api.pin-ngo.com",
        brandHostname: "app.pin-ngo.com",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        data: {
          kind: "PIN_GO_STANDARD",
          displayName: "Pin&Go",
          logoUrl: null,
          faviconUrl: null,
          primaryColor: null,
          onPrimaryColor: null,
          organizationSlug: null,
          version: null,
          poweredByPinGo: true,
        },
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(
        response.headers.get("vary"),
        "Host, X-Forwarded-Host, X-Pin-Go-Brand-Hostname"
      );
    }
  );

  assert.equal(databaseReads, 0);
});

test("query parameter cannot override the real hostname", async () => {
  let databaseReads = 0;

  await withBrandResolverStubs(
    {
      enabled: true,
      domainFindUnique: async () => {
        databaseReads += 1;
        return null;
      },
    },
    async () => {
      const response = await requestRoute({
        host: "api.pin-ngo.com",
        forwardedHost: "app.pin-ngo.com",
        path: "/api/public/brand-context?hostname=portal.casa-azul.example",
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: { kind: string };
      };
      assert.equal(body.data.kind, "PIN_GO_STANDARD");
    }
  );

  assert.equal(databaseReads, 0);
});

test("unknown custom hostname fails closed with a generic response", async () => {
  let profileReads = 0;

  await withBrandResolverStubs(
    {
      enabled: true,
      domainFindUnique: async () => null,
      profileFindUnique: async () => {
        profileReads += 1;
        return publishedProfile();
      },
    },
    async () => {
      const response = await requestRoute({
        host: "api.pin-ngo.com",
        forwardedHost: "unknown.example.com",
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "BRAND_DOMAIN_UNAVAILABLE",
      });
    }
  );

  assert.equal(profileReads, 0);
});

test("published custom hostname returns only its safe visual identity", async () => {
  let domainQuery: unknown;
  let profileQuery: unknown;

  await withBrandResolverStubs(
    {
      enabled: true,
      domainFindUnique: async (...args) => {
        domainQuery = args[0];
        return { id: "brand-domain-a", status: "ACTIVE" };
      },
      profileFindUnique: async (...args) => {
        profileQuery = args[0];
        return publishedProfile();
      },
    },
    async () => {
      const response = await requestRoute({
        host: "api.pin-ngo.com",
        forwardedHost: "api.pin-ngo.com",
        brandHostname: "Portal.Casa-Azul.Example:443",
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        ok: boolean;
        data: Record<string, unknown>;
      };
      assert.deepEqual(body, {
        ok: true,
        data: {
          kind: "CUSTOM_BRAND",
          displayName: "Casa Azul Management",
          logoUrl:
            "https://cdn.example.com/brands/casa-azul-logo.png",
          faviconUrl:
            "https://cdn.example.com/brands/casa-azul-favicon.png",
          primaryColor: "#155EEF",
          onPrimaryColor: "#FFFFFF",
          organizationSlug: "casa-azul",
          version: 3,
          poweredByPinGo: true,
        },
      });
      assert.equal("organizationId" in body.data, false);
    }
  );

  assert.deepEqual(
    (domainQuery as { where: unknown }).where,
    { hostname: "portal.casa-azul.example" }
  );
  assert.deepEqual(
    (profileQuery as { where: unknown }).where,
    { activeDomainId: "brand-domain-a" }
  );
});

test("proxy hostname header cannot override a direct custom hostname", async () => {
  let domainQuery: unknown;

  await withBrandResolverStubs(
    {
      enabled: true,
      domainFindUnique: async (...args) => {
        domainQuery = args[0];
        return null;
      },
    },
    async () => {
      const response = await requestRoute({
        host: "api.pin-ngo.com",
        forwardedHost: "untrusted.example.com",
        brandHostname: "portal.casa-azul.example",
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "BRAND_DOMAIN_UNAVAILABLE",
      });
    }
  );

  assert.deepEqual(
    (domainQuery as { where: unknown }).where,
    { hostname: "untrusted.example.com" }
  );
});

test("ambiguous proxy hostname header is rejected without database reads", async () => {
  let databaseReads = 0;

  await withBrandResolverStubs(
    {
      enabled: true,
      domainFindUnique: async () => {
        databaseReads += 1;
        return null;
      },
    },
    async () => {
      const response = await requestRoute({
        host: "api.pin-ngo.com",
        forwardedHost: "api.pin-ngo.com",
        brandHostname:
          "portal.casa-azul.example, other.casa-azul.example",
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "BRAND_DOMAIN_UNAVAILABLE",
      });
    }
  );

  assert.equal(databaseReads, 0);
});

test("ambiguous forwarded hostname is rejected without database reads", async () => {
  let databaseReads = 0;

  await withBrandResolverStubs(
    {
      enabled: true,
      domainFindUnique: async () => {
        databaseReads += 1;
        return null;
      },
    },
    async () => {
      const response = await requestRoute({
        host: "api.pin-ngo.com",
        forwardedHost:
          "portal.casa-azul.example, proxy.pin-ngo.com",
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "BRAND_DOMAIN_UNAVAILABLE",
      });
    }
  );

  assert.equal(databaseReads, 0);
});

test("disabled feature closes custom hostname without database reads", async () => {
  let databaseReads = 0;

  await withBrandResolverStubs(
    {
      enabled: false,
      domainFindUnique: async () => {
        databaseReads += 1;
        return null;
      },
    },
    async () => {
      const response = await requestRoute({
        host: "api.pin-ngo.com",
        forwardedHost: "portal.casa-azul.example",
      });
      assert.equal(response.status, 404);
    }
  );

  assert.equal(databaseReads, 0);
});

test("unexpected resolver failure does not expose database details", async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    await withBrandResolverStubs(
      {
        enabled: true,
        domainFindUnique: async () => {
          throw new Error("sensitive database detail");
        },
      },
      async () => {
        const response = await requestRoute({
          host: "api.pin-ngo.com",
          forwardedHost: "portal.casa-azul.example",
        });
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.equal(body.includes("sensitive database detail"), false);
        assert.deepEqual(JSON.parse(body), {
          ok: false,
          error: "BRAND_CONTEXT_RESOLUTION_FAILED",
        });
      }
    );
  } finally {
    console.error = originalConsoleError;
  }
});
