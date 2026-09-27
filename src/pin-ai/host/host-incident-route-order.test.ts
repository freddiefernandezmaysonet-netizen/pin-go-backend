import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import { buildHostIncidentRouter } from "../../routes/dashboard.pin-ai-host-incidents.routes.js";
import { buildPropertiesRouter } from "../../routes/properties.route.js";
import { sealHostContent } from "./host-incident-policy.js";

test("production mount order allows token-scoped guest updates while protecting host routes", async () => {
  const source = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
  const hostMount = "app.use(buildHostIncidentRouter({ prisma, env: process.env }));";
  const propertiesMount = "app.use(buildPropertiesRouter(prisma));";
  assert.equal(source.split(hostMount).length, 2, "one host incident router mount");
  assert.ok(source.includes(propertiesMount));
  const env = { PIN_AI_HOST_INCIDENT_ENABLED: "true", PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS: "org-test",
    PIN_AI_HOST_INCIDENT_RESERVATION_IDS: "reservation-test", PIN_AI_HOST_INCIDENT_KEY_ID: "test",
    PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ test: "ab".repeat(32) }) };
  const token = "synthetic-guest-token-valid";
  let reads = 0;
  const prisma = {
    reservation: { findFirst: async ({ where }: any) => {
      reads++;
      assert.equal(where.status, "ACTIVE");
      assert.equal(where.property.status, "ACTIVE");
      assert.ok(where.guestTokenExpiresAt.gt instanceof Date);
      return where.guestToken === token ? { id: "reservation-test", propertyId: "property-test",
        property: { organizationId: "org-test" } } : null;
    } },
    pinAIHostIncidentMessage: { findMany: async ({ where }: any) => {
      assert.equal(where.audience, "GUEST");
      assert.equal(where.kind, "PUBLISH");
      assert.equal(where.thread.reservationId, "reservation-test");
      assert.equal(where.thread.organizationId, "org-test");
      assert.equal(where.thread.propertyId, "property-test");
      return [{ id: "message-test", threadId: "thread-test", sequence: 2,
        createdAt: new Date("2026-09-27T20:00:00Z"),
        contentCiphertext: sealHostContent(env, "org-test:thread-test:2:GUEST", "Published test update"),
        thread: { organizationId: "org-test", issue: { metadata: { reference: "GI-A2D58EB9A0D2" } } } }];
    } },
  } as unknown as PrismaClient;
  const app = express();
  // Reproduce the relative order in the real server, including the existing
  // root-mounted router whose authentication intercepts later public routes.
  const mounts = [
    { at: source.indexOf(hostMount), router: buildHostIncidentRouter({ prisma, env }) },
    { at: source.indexOf(propertiesMount), router: buildPropertiesRouter(prisma) },
  ].sort((a, b) => a.at - b.at);
  for (const mount of mounts) app.use(mount.router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const result = await fetch(`${base}/api/public-booking/manage/${token}/pin-ai/incident-updates`);
    assert.equal(result.status, 200, "guest must not require a Dashboard cookie");
    const body = await result.json();
    assert.equal(body.updates[0].text, "Published test update");
    assert.equal(body.nextAfter, null);
    assert.equal(result.headers.get("cache-control"), "no-store");
    const invalid = await fetch(`${base}/api/public-booking/manage/synthetic-unknown-token/pin-ai/incident-updates`);
    assert.equal(invalid.status, 404);
    assert.equal(reads, 2);
    for (const path of ["/api/dashboard/pin-ai/incidents", "/api/properties"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, `${path} remains authenticated`);
    }
    const command = await fetch(`${base}/api/dashboard/pin-ai/incidents/GI-A2D58EB9A0D2/actions`, { method: "POST" });
    assert.equal(command.status, 401, "host writes remain authenticated");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
