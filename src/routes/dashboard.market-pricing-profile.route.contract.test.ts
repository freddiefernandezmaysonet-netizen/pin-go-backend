import assert from "node:assert/strict";
import test from "node:test";

import express, { type RequestHandler } from "express";
import request from "supertest";

import {
  buildDashboardMarketPricingProfileRouter,
  type MarketPricingProfileRouteActions,
} from "./dashboard.market-pricing-profile.route";

function actorAuth(role = "ORG_ADMIN"): RequestHandler {
  return (req, _res, next) => {
    (req as any).user = {
      id: "user-1",
      orgId: "organization-1",
      role,
    };
    next();
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    propertyId: "property-1",
    enabled: false,
    provider: null,
    currency: "USD",
    strategy: "BALANCED",
    position: "COMPETITIVE",
    aggressiveness: "MODERATE",
    minimumConfidence: 70,
    maximumIncreasePercent: 20,
    maximumDecreasePercent: 15,
    marketRadiusKm: null,
    maximumComparables: 10,
    refreshIntervalHours: 24,
    lastSuccessfulRefreshAt: null,
    nextRefreshAt: null,
    lastErrorCode: null,
    updatedAt: new Date("2026-09-23T03:00:00.000Z"),
    ...overrides,
  };
}

function application(input: {
  actions: MarketPricingProfileRouteActions;
  auth?: RequestHandler;
}) {
  const app = express();
  app.use(express.json());
  app.use(
    buildDashboardMarketPricingProfileRouter({
      auth: input.auth ?? actorAuth(),
      actions: input.actions,
    }),
  );
  return app;
}

test("GET reports that an owned property is not configured", async () => {
  let received: unknown;
  const app = application({
    actions: {
      async read(input) {
        received = input;
        return { configured: false, profile: null };
      },
      async configure() {
        assert.fail("configure must not run");
      },
    },
  });

  const response = await request(app).get(
    "/api/dashboard/properties/property-1/market-pricing",
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(received, {
    organizationId: "organization-1",
    propertyId: "property-1",
  });
  assert.deepEqual(response.body, {
    ok: true,
    propertyId: "property-1",
    marketPricing: { configured: false },
  });
});

test("GET exposes configuration state without revealing the provider key", async () => {
  const app = application({
    actions: {
      async read() {
        return {
          configured: true,
          profile: profile({
            enabled: true,
            provider: "secret-provider-key",
            marketRadiusKm: "12.50",
            nextRefreshAt: new Date("2026-09-24T03:00:00.000Z"),
          }),
        };
      },
      async configure() {
        assert.fail("configure must not run");
      },
    },
  });

  const response = await request(app).get(
    "/api/dashboard/properties/property-1/market-pricing",
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.marketPricing.providerAssigned, true);
  assert.equal(response.body.marketPricing.provider, undefined);
  assert.equal(response.body.marketPricing.marketRadiusKm, 12.5);
  assert.equal(
    response.body.marketPricing.nextRefreshAt,
    "2026-09-24T03:00:00.000Z",
  );
});

test("PUT forwards only host-configurable fields with tenant identity", async () => {
  let received: any;
  const app = application({
    actions: {
      async read() {
        assert.fail("read must not run");
      },
      async configure(input) {
        received = input;
        return profile({ enabled: true, provider: "assigned-provider" });
      },
    },
  });

  const configuration = {
    enabled: true,
    currency: "USD",
    strategy: "BALANCED",
    position: "COMPETITIVE",
    aggressiveness: "MODERATE",
    marketRadiusKm: 15,
    maximumComparables: 12,
  };
  const response = await request(app)
    .put("/api/dashboard/properties/property-1/market-pricing")
    .send(configuration);

  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    organizationId: "organization-1",
    propertyId: "property-1",
    configuration,
  });
  assert.equal(response.body.marketPricing.providerAssigned, true);
  assert.equal(response.body.marketPricing.provider, undefined);
});

test("PUT rejects provider assignment and unknown fields before actions", async () => {
  let configureCount = 0;
  const app = application({
    actions: {
      async read() {
        return { configured: false, profile: null };
      },
      async configure() {
        configureCount += 1;
        return profile();
      },
    },
  });

  for (const body of [
    { enabled: false, currency: "USD", assignedProviderKey: "provider" },
    { enabled: false, currency: "USD", provider: "provider" },
    { enabled: false, currency: "USD", unexpected: true },
  ]) {
    const response = await request(app)
      .put("/api/dashboard/properties/property-1/market-pricing")
      .send(body);
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error,
      "MARKET_PRICING_CONFIGURATION_FIELD_NOT_ALLOWED",
    );
  }
  assert.equal(configureCount, 0);
});

test("non-admin users cannot read or modify market pricing", async () => {
  let actionCount = 0;
  const app = application({
    auth: actorAuth("MEMBER"),
    actions: {
      async read() {
        actionCount += 1;
        return { configured: false, profile: null };
      },
      async configure() {
        actionCount += 1;
        return profile();
      },
    },
  });

  const get = await request(app).get(
    "/api/dashboard/properties/property-1/market-pricing",
  );
  const put = await request(app)
    .put("/api/dashboard/properties/property-1/market-pricing")
    .send({ enabled: false, currency: "USD" });

  assert.equal(get.status, 403);
  assert.equal(put.status, 403);
  assert.equal(actionCount, 0);
});

test("route maps property and activation conflicts without leaking details", async () => {
  const notFound = application({
    actions: {
      async read() {
        throw new Error("MARKET_PRICING_PROPERTY_NOT_FOUND");
      },
      async configure() {
        return profile();
      },
    },
  });
  const conflict = application({
    actions: {
      async read() {
        return { configured: false, profile: null };
      },
      async configure() {
        throw new Error("MARKET_PRICING_PROVIDER_REQUIRED_FOR_ACTIVATION");
      },
    },
  });

  const missing = await request(notFound).get(
    "/api/dashboard/properties/property-1/market-pricing",
  );
  const unavailable = await request(conflict)
    .put("/api/dashboard/properties/property-1/market-pricing")
    .send({ enabled: true, currency: "USD" });

  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "MARKET_PRICING_PROPERTY_NOT_FOUND");
  assert.equal(unavailable.status, 409);
  assert.equal(
    unavailable.body.error,
    "MARKET_PRICING_PROVIDER_REQUIRED_FOR_ACTIVATION",
  );
});

test("authentication middleware remains mandatory", async () => {
  const auth: RequestHandler = (_req, res) => {
    res.status(401).json({ error: "UNAUTHENTICATED" });
  };
  const app = application({
    auth,
    actions: {
      async read() {
        assert.fail("read must not run");
      },
      async configure() {
        assert.fail("configure must not run");
      },
    },
  });

  const response = await request(app).get(
    "/api/dashboard/properties/property-1/market-pricing",
  );
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "UNAUTHENTICATED");
});

test("stored data corruption is sanitized as an internal error", async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const app = application({
      actions: {
        async read() {
          return {
            configured: true,
            profile: profile({ updatedAt: "not-a-date" }) as any,
          };
        },
        async configure() {
          assert.fail("configure must not run");
        },
      },
    });

    const response = await request(app).get(
      "/api/dashboard/properties/property-1/market-pricing",
    );
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      ok: false,
      error: "MARKET_PRICING_ROUTE_ERROR",
    });
  } finally {
    console.error = originalError;
  }
});
