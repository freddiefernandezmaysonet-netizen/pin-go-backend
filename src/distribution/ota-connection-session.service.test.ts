import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  expireUnopenedOtaConnectionSessions,
  issueOtaConnectionSession,
  OtaConnectionSessionError,
  transitionOtaConnectionSession,
  type OtaConnectionSessionClient,
} from "./ota-connection-session.service.js";

function createClient(options: { ready?: boolean; duplicate?: boolean; corrupt?: boolean } = {}) {
  const sessions: any[] = [];
  const audits: any[] = [];
  const updates: any[] = [];
  const ready = options.ready !== false;
  const client: OtaConnectionSessionClient = {
    dashboardUser: { async findFirst() { return { id: "user-1" }; } },
    property: { async findFirst() { return { id: "property-1" }; } },
    otaChannelConnection: {
      async findFirst() {
        return {
          id: "connection-1",
          organizationId: "org-1",
          propertyId: "property-1",
          provider: "AIRBNB",
          distributionProperty: {
            organizationId: options.corrupt ? "org-other" : "org-1",
            propertyId: "property-1",
            provisioningStatus: ready ? "READY" : "NOT_PROVISIONED",
            externalPropertyId: ready ? "external-property" : null,
            group: {
              organizationId: "org-1",
              provisioningStatus: ready ? "READY" : "NOT_PROVISIONED",
              externalGroupId: ready ? "external-group" : null,
            },
          },
        };
      },
    },
    otaConnectionSession: {
      async findUnique() {
        return options.duplicate
          ? { id: "old-session", organizationId: "org-1", propertyId: "property-1", requestedByUserId: "user-1", provider: "AIRBNB", status: "TOKEN_ISSUED", expiresAt: new Date() }
          : null;
      },
      async create(args: any) {
        const value = { id: "session-1", ...args.data };
        sessions.push(value);
        return value;
      },
      async updateMany(args: any) { updates.push(args); return { count: 1 }; },
    },
    apmsAuditEntry: { async create(args: any) { audits.push(args.data); return {}; } },
  };
  return { client, sessions, audits, updates };
}

const base = {
  organizationId: "org-1",
  propertyId: "property-1",
  requestedByUserId: "user-1",
  provider: "AIRBNB" as const,
  requestKey: "request-1",
  now: new Date("2026-09-05T19:00:00.000Z"),
  allowedLaunchOrigins: new Set(["https://app.channex.io"]),
};

test("issued secret is returned once while persistence keeps only SHA-256 and origin", async () => {
  const { client, sessions, audits, updates } = createClient();
  const issuer = {
    async issue() {
      return { token: "one-time-secret", launchUrl: "https://app.channex.io/channels?mode=iframe" };
    },
  };
  const result = await issueOtaConnectionSession({ client, issuer, ...base });

  assert.equal(result.token, "one-time-secret");
  assert.equal(sessions[0].status, "REQUESTED");
  assert.equal(updates[0].data.tokenFingerprint, createHash("sha256").update("one-time-secret").digest("hex"));
  assert.equal(updates[0].data.launchUrlOrigin, "https://app.channex.io");
  assert.equal(JSON.stringify({ sessions, audits, updates }).includes("one-time-secret"), false);
  assert.equal(JSON.stringify({ sessions, audits, updates }).includes("mode=iframe"), false);
});

test("session issuance is blocked until group and property provisioning are ready", async () => {
  const { client, sessions } = createClient({ ready: false });
  let issuerCalls = 0;
  await assert.rejects(
    issueOtaConnectionSession({
      client,
      issuer: { async issue() { issuerCalls += 1; return { token: "x", launchUrl: "https://app.channex.io" }; } },
      ...base,
    }),
    /DISTRIBUTION_PROVISIONING_REQUIRED/
  );
  assert.equal(issuerCalls, 0);
  assert.deepEqual(sessions, []);
});

test("a repeated request key never reissues the one-time secret", async () => {
  const { client } = createClient({ duplicate: true });
  let issuerCalls = 0;
  await assert.rejects(
    issueOtaConnectionSession({
      client,
      issuer: { async issue() { issuerCalls += 1; return { token: "x", launchUrl: "https://app.channex.io" }; } },
      ...base,
    }),
    /OTA_CONNECTION_REQUEST_ALREADY_USED/
  );
  assert.equal(issuerCalls, 0);
});

test("cross-tenant connection evidence is rejected before token issuance", async () => {
  const { client, sessions } = createClient({ corrupt: true });
  let issuerCalls = 0;
  await assert.rejects(
    issueOtaConnectionSession({
      client,
      issuer: { async issue() { issuerCalls += 1; return { token: "x", launchUrl: "https://app.channex.io" }; } },
      ...base,
    }),
    /OTA_DISTRIBUTION_TENANT_MISMATCH/
  );
  assert.equal(issuerCalls, 0);
  assert.deepEqual(sessions, []);
});

test("non-HTTPS or unapproved iframe origins fail closed", async () => {
  for (const launchUrl of ["http://app.channex.io", "https://evil.example/iframe"]) {
    const { client, updates } = createClient();
    await assert.rejects(
      issueOtaConnectionSession({
        client,
        issuer: { async issue() { return { token: "one-time-secret", launchUrl }; } },
        ...base,
      }),
      /OTA_CONNECTION_LAUNCH_ORIGIN_FORBIDDEN/
    );
    assert.equal(JSON.stringify(updates).includes("one-time-secret"), false);
    assert.equal(updates.at(-1).data.status, "FAILED");
  }
});

test("issuer failures are reduced to a stable code without leaking provider details", async () => {
  const { client, audits, updates } = createClient();
  await assert.rejects(
    issueOtaConnectionSession({
      client,
      issuer: { async issue() { throw new Error("provider-secret-response"); } },
      ...base,
    }),
    (error: unknown) => error instanceof OtaConnectionSessionError && error.code === "OTA_CONNECTION_TOKEN_ISSUER_FAILED"
  );
  const persisted = JSON.stringify({ audits, updates });
  assert.equal(persisted.includes("provider-secret-response"), false);
  assert.match(persisted, /OTA_CONNECTION_TOKEN_ISSUER_FAILED/);
});

test("session transitions use tenant, actor, current state and expiry as CAS guards", async () => {
  const { client, updates } = createClient();
  await transitionOtaConnectionSession({
    client,
    organizationId: "org-1",
    requestedByUserId: "user-1",
    sessionId: "session-1",
    current: "TOKEN_ISSUED",
    next: "OPENED",
    now: base.now,
  });
  assert.deepEqual(updates[0].where, {
    id: "session-1",
    organizationId: "org-1",
    requestedByUserId: "user-1",
    status: "TOKEN_ISSUED",
    expiresAt: { gt: base.now },
  });
  await assert.rejects(
    transitionOtaConnectionSession({
      client,
      organizationId: "org-1",
      requestedByUserId: "user-1",
      sessionId: "session-1",
      current: "REQUESTED",
      next: "COMPLETED",
    }),
    /OTA_CONNECTION_SESSION_TRANSITION_INVALID/
  );
});

test("only unopened sessions expire; an opened iframe can complete after token TTL", async () => {
  const { client, updates } = createClient();
  await transitionOtaConnectionSession({
    client,
    organizationId: "org-1",
    requestedByUserId: "user-1",
    sessionId: "session-1",
    current: "OPENED",
    next: "COMPLETED",
    now: base.now,
  });
  assert.equal("expiresAt" in updates[0].where, false);

  const count = await expireUnopenedOtaConnectionSessions({ client, now: base.now });
  assert.equal(count, 1);
  assert.deepEqual(updates[1], {
    where: {
      status: { in: ["REQUESTED", "TOKEN_ISSUED"] },
      expiresAt: { lte: base.now },
    },
    data: { status: "EXPIRED" },
  });
});

test("an opened iframe can be cancelled without applying token expiry", async () => {
  const { client, updates } = createClient();
  await transitionOtaConnectionSession({
    client,
    organizationId: "org-1",
    requestedByUserId: "user-1",
    sessionId: "session-1",
    current: "OPENED",
    next: "CANCELLED",
    now: base.now,
  });
  assert.equal("expiresAt" in updates[0].where, false);
  assert.equal(updates[0].data.status, "CANCELLED");
});
