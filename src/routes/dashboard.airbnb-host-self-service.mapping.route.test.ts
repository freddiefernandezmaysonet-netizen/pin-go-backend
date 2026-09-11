import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type RequestHandler } from "express";

import {
  buildDashboardAirbnbHostSelfServiceRouter,
  type AirbnbHostSelfServiceRouteActions,
} from "./dashboard.airbnb-host-self-service.route.js";
import { AIRBNB_HOST_MAPPING_CONFIRMATION } from "../distribution/airbnb-host-confirmed-mapping.service.js";

type TestUser = { id: string; orgId: string; role?: string };

function actions(overrides: Partial<AirbnbHostSelfServiceRouteActions> = {}): AirbnbHostSelfServiceRouteActions {
  return {
    enabled: true,
    isTrustedOrigin: async (origin) => origin === "https://app.pin-ngo.com",
    issueConnectionLink: async () => { throw new Error("not used"); },
    listListings: async () => { throw new Error("not used"); },
    confirmMapping: async () => ({
      outcome: "MAPPING_SUBMITTED",
      listingId: "551126434553599406",
      mappingId: "11111111-1111-4111-8111-111111111111",
    }),
    verifyCallback: async () => { throw new Error("not used"); },
    ...overrides,
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function requestMapping(args: {
  user?: TestUser;
  routeActions: AirbnbHostSelfServiceRouteActions;
  origin?: string;
  idempotencyKey?: string;
  body?: unknown;
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
      `http://127.0.0.1:${address.port}/api/dashboard/distribution/properties/property-1/channels/AIRBNB/mapping`,
      {
        method: "POST",
        headers: {
          Connection: "close",
          "Content-Type": "application/json",
          ...(args.origin ? { Origin: args.origin } : {}),
          ...(args.idempotencyKey
            ? { "Idempotency-Key": args.idempotencyKey }
            : {}),
        },
        body: JSON.stringify(
          args.body ?? {
            listingId: "551126434553599406",
            confirmation: AIRBNB_HOST_MAPPING_CONFIRMATION,
          }
        ),
      }
    );
  } finally {
    await closeServer(server);
  }
}

const ADMIN = { id: "user-1", orgId: "org-1", role: "ORG_ADMIN" };
const SAFE_KEY = "airbnb-map-12345678";

test("mapping route forwards explicit host confirmation and hides provider mapping id", async () => {
  let received: unknown;
  const response = await requestMapping({
    user: ADMIN,
    routeActions: actions({
      confirmMapping: async (input) => {
        received = input;
        return {
          outcome: "MAPPING_SUBMITTED",
          listingId: "551126434553599406",
          mappingId: "11111111-1111-4111-8111-111111111111",
        };
      },
    }),
    origin: "https://app.pin-ngo.com",
    idempotencyKey: SAFE_KEY,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(received, {
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    requestKey: SAFE_KEY,
    listingId: "551126434553599406",
    confirmation: AIRBNB_HOST_MAPPING_CONFIRMATION,
  });
  const body = await response.json() as any;
  assert.deepEqual(body, {
    ok: true,
    mapping: {
      outcome: "MAPPING_SUBMITTED",
      listingId: "551126434553599406",
    },
  });
  assert.equal(JSON.stringify(body).includes("11111111-1111-4111-8111-111111111111"), false);
});

test("mapping mutation requires admin, trusted origin and valid idempotency key", async () => {
  let calls = 0;
  const routeActions = actions({
    confirmMapping: async () => {
      calls += 1;
      return {
        outcome: "MAPPING_SUBMITTED",
        listingId: "551126434553599406",
        mappingId: null,
      };
    },
  });

  const unauthenticated = await requestMapping({
    routeActions,
    origin: "https://app.pin-ngo.com",
    idempotencyKey: SAFE_KEY,
  });
  assert.equal(unauthenticated.status, 401);

  const member = await requestMapping({
    user: { id: "user-1", orgId: "org-1", role: "MEMBER" },
    routeActions,
    origin: "https://app.pin-ngo.com",
    idempotencyKey: SAFE_KEY,
  });
  assert.equal(member.status, 403);

  const noOrigin = await requestMapping({
    user: ADMIN,
    routeActions,
    idempotencyKey: SAFE_KEY,
  });
  assert.equal(noOrigin.status, 403);

  const badOrigin = await requestMapping({
    user: ADMIN,
    routeActions,
    origin: "https://evil.example",
    idempotencyKey: SAFE_KEY,
  });
  assert.equal(badOrigin.status, 403);

  const badKey = await requestMapping({
    user: ADMIN,
    routeActions,
    origin: "https://app.pin-ngo.com",
    idempotencyKey: "bad",
  });
  assert.equal(badKey.status, 400);
  assert.equal(calls, 0);
});

test("mapping route is unavailable unless the runtime action is composed", async () => {
  const routeActions = actions();
  routeActions.confirmMapping = undefined;
  const response = await requestMapping({
    user: ADMIN,
    routeActions,
    origin: "https://app.pin-ngo.com",
    idempotencyKey: SAFE_KEY,
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "OTA_AIRBNB_MAPPING_UNAVAILABLE",
  });
});

test("mapping conflicts are surfaced as 409 without exposing provider payloads", async () => {
  const response = await requestMapping({
    user: ADMIN,
    routeActions: actions({
      confirmMapping: async () => {
        throw Object.assign(new Error("hidden"), {
          code: "OTA_AIRBNB_MAPPING_CONFLICT",
        });
      },
    }),
    origin: "https://app.pin-ngo.com",
    idempotencyKey: SAFE_KEY,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "OTA_AIRBNB_MAPPING_CONFLICT",
  });
});
