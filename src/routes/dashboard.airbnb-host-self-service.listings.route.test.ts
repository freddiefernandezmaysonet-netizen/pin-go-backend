import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type RequestHandler } from "express";

import {
  buildDashboardAirbnbHostSelfServiceRouter,
  type AirbnbHostSelfServiceRouteActions,
} from "./dashboard.airbnb-host-self-service.route.js";

type TestUser = { id: string; orgId: string; role?: string };

const EMPTY_DISCOVERY = {
  channelId: "unused",
  listings: [],
  match: {
    propertyId: "property-1",
    status: "UNMATCHED" as const,
    confidence: "LOW" as const,
    candidateListingId: null,
    candidateTitle: null,
    score: 0,
    runnerUpScore: null,
    reasons: ["NO_LISTING_CANDIDATE"],
  },
  portfolioSummary: {
    propertiesConsidered: 1,
    listingsConsidered: 0,
    autoMatched: 0,
    reviewRequired: 0,
    unmatched: 1,
  },
};

function actions(overrides: Partial<AirbnbHostSelfServiceRouteActions> = {}): AirbnbHostSelfServiceRouteActions {
  return {
    enabled: true,
    isTrustedOrigin: async () => true,
    issueConnectionLink: async () => {
      throw new Error("not used");
    },
    listListings: async () => EMPTY_DISCOVERY,
    verifyCallback: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function requestRoute(args: {
  user?: TestUser;
  routeActions: AirbnbHostSelfServiceRouteActions;
}) {
  const app = express();
  if (args.user) {
    const injectUser: RequestHandler = (req, _res, next) => {
      (req as typeof req & { user: TestUser }).user = args.user!;
      next();
    };
    app.use(injectUser);
  }
  app.use(express.json());
  app.use(buildDashboardAirbnbHostSelfServiceRouter(args.routeActions));

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;
  try {
    return await fetch(
      `http://127.0.0.1:${address.port}/api/dashboard/distribution/properties/property-1/channels/AIRBNB/listings`,
      { method: "GET", headers: { Connection: "close" } }
    );
  } finally {
    await closeServer(server);
  }
}

test("listing discovery is unavailable when Airbnb self-service is disabled", async () => {
  let calls = 0;
  const response = await requestRoute({
    user: { id: "user-1", orgId: "org-1", role: "ORG_ADMIN" },
    routeActions: actions({
      enabled: false,
      listListings: async () => {
        calls += 1;
        return EMPTY_DISCOVERY;
      },
    }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls, 0);
});

test("listing discovery requires an authenticated admin actor", async () => {
  let calls = 0;
  const routeActions = actions({
    listListings: async () => {
      calls += 1;
      return EMPTY_DISCOVERY;
    },
  });

  const unauthenticated = await requestRoute({ routeActions });
  assert.equal(unauthenticated.status, 401);

  const member = await requestRoute({
    user: { id: "user-1", orgId: "org-1", role: "MEMBER" },
    routeActions,
  });
  assert.equal(member.status, 403);
  assert.equal(calls, 0);
});

test("listing discovery returns read-only matching evidence without exposing provider channel id", async () => {
  let received: unknown;
  const response = await requestRoute({
    user: { id: "user-1", orgId: "org-1", role: "ORG_ADMIN" },
    routeActions: actions({
      listListings: async (args) => {
        received = args;
        return {
          channelId: "44444444-4444-4444-8444-444444444444",
          listings: [
            {
              id: "42544559",
              title: "Test Property · Test Channex Property",
              type: "apartment",
              occupancies: [1, 2, 3, 4],
              synchronizationCategory: "text",
              city: "text",
              countryCode: "DE",
              qualityStatus: "text",
            },
          ],
          match: {
            propertyId: "property-1",
            status: "AUTO_MATCH",
            confidence: "HIGH",
            candidateListingId: "42544559",
            candidateTitle: "Test Property · Test Channex Property",
            score: 95.8,
            runnerUpScore: null,
            reasons: ["NAME_STRONG", "CITY_MATCH", "COUNTRY_MATCH", "MAX_GUESTS_MATCH"],
          },
          portfolioSummary: {
            propertiesConsidered: 10,
            listingsConsidered: 8,
            autoMatched: 6,
            reviewRequired: 2,
            unmatched: 2,
          },
        };
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(received, {
    organizationId: "org-1",
    propertyId: "property-1",
  });
  const body = await response.json() as any;
  assert.equal(body.ok, true);
  assert.equal(body.listings[0].id, "42544559");
  assert.equal(body.match.status, "AUTO_MATCH");
  assert.equal(body.match.confidence, "HIGH");
  assert.equal(body.match.candidateListingId, "42544559");
  assert.deepEqual(body.portfolioSummary, {
    propertiesConsidered: 10,
    listingsConsidered: 8,
    autoMatched: 6,
    reviewRequired: 2,
    unmatched: 2,
  });
  assert.equal(JSON.stringify(body).includes("44444444-4444-4444-8444-444444444444"), false);
});
