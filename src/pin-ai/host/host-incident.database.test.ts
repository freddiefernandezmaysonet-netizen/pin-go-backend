import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { buildHostIncidentRouter } from "../../routes/dashboard.pin-ai-host-incidents.routes.js";
import { handleGuestIncident } from "../guest/guest-incident.service.js";
import { applyHostIncidentCommand, listHostIncidents, readHostIncident, readPublishedIncidentUpdates } from "./host-incident.service.js";
import type { PinAIRuntimeRequest } from "../runtime/contracts.js";

const enabled = process.env.PIN_AI_HOST_INCIDENT_DB_TEST === "true";
const url = new URL(process.env.DATABASE_URL ?? "http://missing");
if (enabled && (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/pin_ai_host_incident_test")) {
  throw new Error("Host tests require isolated local pin_ai_host_incident_test");
}
test("PostgreSQL host foundation: tenant isolation, concurrency, privacy, revocation and single-case closure", { skip: !enabled }, async () => {
  const prisma = new PrismaClient(), now = new Date();
  const org = await prisma.organization.create({ data: { name: "Synthetic host foundation" } });
  const other = await prisma.organization.create({ data: { name: "Unrelated host" } });
  const property = await prisma.property.create({ data: { organizationId: org.id, name: "Synthetic property" } });
  const token = `synthetic-${randomUUID()}`;
  const reservation = await prisma.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest",
    guestToken: token, guestTokenExpiresAt: new Date(now.getTime() + 86400000), checkIn: now, checkOut: new Date(now.getTime() + 86400000) } });
  const user = await prisma.dashboardUser.create({ data: { organizationId: org.id, email: `${randomUUID()}@example.test`, passwordHash: "synthetic", role: "PLATFORM_ADMIN" } });
  const outsider = await prisma.dashboardUser.create({ data: { organizationId: other.id, email: `${randomUUID()}@example.test`, passwordHash: "synthetic", role: "PLATFORM_ADMIN" } });
  const env = { PIN_AI_HOST_INCIDENT_ENABLED: "true", PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS: org.id,
    PIN_AI_HOST_INCIDENT_RESERVATION_IDS: reservation.id, PIN_AI_HOST_INCIDENT_KEY_ID: "test",
    PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ test: "ab".repeat(32) }) };
  const actor = { id: user.id, orgId: org.id }, base = { prisma, env, actor };
  const request: PinAIRuntimeRequest = { context: { organizationId: org.id, propertyId: property.id,
    reservationId: reservation.id, guestId: "test", currentLocalDateTime: now.toISOString(), preferredLanguage: "es" },
    conversation: [{ role: "guest", content: "El agua está fría" }] };
  const guestBase = { prisma, request, guestToken: token, env: { PIN_AI_INCIDENT_ENABLED: "true",
    PIN_AI_INCIDENT_CANARY_RESERVATION_IDS: reservation.id }, now };
  const report = { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["El agua está fría"] };
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const receipt = await handleGuestIncident({ ...guestBase, args: report });
    const ref = receipt!.reference;
    const second = await handleGuestIncident({ ...guestBase, args: { ...report, category: "OTHER" } });
    const read = () => readHostIncident({ ...base, reference: ref });
    const action = (operation: string, text: string, expectedVersion: number, requestId = randomUUID()) =>
      applyHostIncidentCommand({ ...base, reference: ref, command: { operation, text, expectedVersion, requestId } });
    assert.equal((await listHostIncidents(base)).items.length, 2);
    const statusOnly = await readPublishedIncidentUpdates({ prisma, env, guestToken: token });
    assert.equal(statusOnly.incidents.length, 2, "guest sees incident status without a published message");
    assert.equal(statusOnly.updates.length, 0, "status projection must not synthesize a host message");
    assert.equal(statusOnly.incidents.find(i => i.reference === ref)?.resolution, "OPEN");
    assert.equal(statusOnly.incidents.find(i => i.reference === ref)?.hostAcknowledged, false);
    assert.equal((await read()).version, 0);
    for (const role of ["ADMIN", "ORG_ADMIN", "PLATFORM_ADMIN"] as const) {
      await prisma.dashboardUser.update({ where: { id: user.id }, data: { role } });
      assert.equal((await read()).version, 0);
    }
    assert.equal(await prisma.pinAIHostIncidentThread.count(), 0, "reads must not create threads");
    for (const wrong of [{ id: outsider.id, orgId: other.id }, { id: outsider.id, orgId: org.id }]) {
      await assert.rejects(readHostIncident({ ...base, actor: wrong, reference: ref }), /NOT_FOUND|ACCESS_DENIED/);
      await assert.rejects(applyHostIncidentCommand({ ...base, actor: wrong, reference: ref,
        command: { operation: "RESOLVE", text: "x", expectedVersion: 0, requestId: randomUUID() } }), /NOT_FOUND|ACCESS_DENIED/);
    }
    await assert.rejects(readHostIncident({ ...base, env: {}, reference: ref }), /NOT_FOUND/);
    const duplicateId = randomUUID();
    const duplicate = await Promise.all([1, 2].map(() => action("NOTE", "Private internal detail", 0, duplicateId)));
    assert.equal(duplicate[0].eventId, duplicate[1].eventId);
    assert.equal((await read()).messages.length, 1);
    await assert.rejects(action("PUBLISH", "Different payload", 0, duplicateId), /REQUEST_ID_REUSED/);
    const race = await Promise.allSettled([action("NOTE", "Concurrent A", 1), action("NOTE", "Concurrent B", 1)]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await read()).version, 2);
    await assert.rejects(action("PUBLISH", "Stale", 1), /VERSION_CONFLICT/);
    await action("ACKNOWLEDGE", "", 2);
    assert.ok((await read()).acknowledgedAt);
    await action("PUBLISH", "El anfitrión está revisando el reporte", 3);
    const updates = await readPublishedIncidentUpdates({ prisma, env, guestToken: token });
    assert.equal(updates.updates.length, 1);
    assert.equal(updates.updates[0].text, "El anfitrión está revisando el reporte");
    assert.equal(updates.incidents.find(i => i.reference === ref)?.resolution, "OPEN");
    assert.equal(updates.incidents.find(i => i.reference === ref)?.hostAcknowledged, true);
    assert.equal((await handleGuestIncident({ ...guestBase, args: { operation: "STATUS", category: "HOT_WATER" } }))!.hostAcknowledged, true);
    assert.doesNotMatch(JSON.stringify(updates), /Private|Concurrent|actorId|INTERNAL/);
    await assert.rejects(readPublishedIncidentUpdates({ prisma, env, guestToken: "wrong" }), /NOT_FOUND/);
    const cipher = await prisma.pinAIHostIncidentMessage.findMany();
    assert.ok(cipher.every(m => !m.contentCiphertext.includes("Private")));
    // Failure after thread/event updates rolls back the entire command.
    await prisma.$executeRawUnsafe(`ALTER TABLE "OperationalIssueTransition" ADD CONSTRAINT host_test_reject_note CHECK ("transitionCode" <> 'HOST_INCIDENT_NOTE') NOT VALID`);
    try { await assert.rejects(action("NOTE", "Should roll back", 4)); }
    finally { await prisma.$executeRawUnsafe('ALTER TABLE "OperationalIssueTransition" DROP CONSTRAINT host_test_reject_note'); }
    assert.equal((await read()).version, 4);
    for (const change of [{ isActive: false }, { role: "MEMBER" as const }, { organizationId: other.id }]) {
      await prisma.dashboardUser.update({ where: { id: user.id }, data: change });
      await assert.rejects(read(), /ACCESS_DENIED/);
      await assert.rejects(action("PUBLISH", "Must reject", 4), /ACCESS_DENIED/);
      await prisma.dashboardUser.update({ where: { id: user.id }, data: { isActive: true, role: "PLATFORM_ADMIN", organizationId: org.id } });
    }
    const closeId = randomUUID(); await action("RESOLVE", "Host supplied outcome", 4, closeId);
    assert.equal((await read()).state, "RESOLVED");
    const closedUpdates = await readPublishedIncidentUpdates({ prisma, env, guestToken: token });
    assert.equal(closedUpdates.incidents.find(i => i.reference === ref)?.resolution, "RESOLVED");
    assert.equal(closedUpdates.incidents.find(i => i.reference === ref)?.hostAcknowledged, true);
    assert.doesNotMatch(JSON.stringify(closedUpdates), /Host supplied outcome|Private|Concurrent|actorId|INTERNAL/);
    const closedReceipt = await handleGuestIncident({ ...guestBase, args: { operation: "STATUS", category: "HOT_WATER" } });
    assert.equal(closedReceipt!.resolution, "RESOLVED");
    assert.equal(closedReceipt!.hostAcknowledged, true);
    assert.equal((await action("RESOLVE", "Host supplied outcome", 4, closeId)).replayed, true);
    await assert.rejects(action("NOTE", "closed", 5), /INCIDENT_RESOLVED/);
    assert.equal((await readHostIncident({ ...base, reference: second!.reference })).state, "ACTION_REQUIRED");
    const recurrence = await handleGuestIncident({ ...guestBase, args: report });
    assert.notEqual(recurrence!.reference, ref);
    assert.equal(recurrence!.hostAcknowledged, false);
    assert.equal((await readHostIncident({ ...base, reference: recurrence!.reference })).version, 0);
    // Host access survives checkout; guest access still expires.
    await prisma.reservation.update({ where: { id: reservation.id }, data: { checkOut: new Date(now.getTime() - 1000), guestTokenExpiresAt: new Date(now.getTime() - 1000) } });
    assert.equal((await read()).version, 5);
    await assert.rejects(readPublishedIncidentUpdates({ prisma, env, guestToken: token }), /NOT_FOUND/);

    // Exercise actual routing, origin protection and disabled behavior.
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { if (req.get("x-test-actor") === user.id) (req as any).user = actor; next(); });
    process.env.CI = "true";
    app.use(buildHostIncidentRouter({ prisma, env }));
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/api/dashboard/pin-ai/incidents/${ref}`;
    assert.equal((await fetch(endpoint)).status, 401);
    // Middleware's injected CI identity expects id + orgId, never guest token.
    assert.equal((await fetch(endpoint, { headers: { "x-test-actor": user.id } })).status, 200);
    assert.equal((await fetch(`${endpoint}/actions`, { method: "POST", headers: { "x-test-actor": user.id,
      cookie: "pingo_token=synthetic", origin: "https://attacker.example", "content-type": "application/json" }, body: "{}" })).status, 403);
    env.PIN_AI_HOST_INCIDENT_ENABLED = "false";
    assert.equal((await fetch(endpoint, { headers: { "x-test-actor": user.id } })).status, 404);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
    await prisma.messageLog.deleteMany({ where: { reservationId: reservation.id } });
    await prisma.operationalIssue.deleteMany({ where: { reservationId: reservation.id } });
    await prisma.reservation.delete({ where: { id: reservation.id } });
    await prisma.property.delete({ where: { id: property.id } });
    await prisma.dashboardUser.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
    await prisma.$disconnect();
  }
});
