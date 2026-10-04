import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { handleGuestIncident } from "./guest-incident.service.js";
import { deliverGuestIncidentNotice } from "./guest-incident-notification.service.js";
import { recordMessageDeliveryOutcome } from "../../services/guest-journey-communications-delivery-outcome.service.js";
import { sealGuestHistory } from "./guest-history.js";
import type { PinAIRuntimeRequest } from "../runtime/contracts.js";
import { listHostIncidents, readHostIncident, applyHostIncidentCommand } from "../host/host-incident.service.js";

const enabled = process.env.PIN_AI_INCIDENT_DB_TEST === "true";
const url = new URL(process.env.DATABASE_URL ?? "http://missing");
if (enabled && (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/pin_ai_incident_test")) {
  throw new Error("Incident DB tests require the isolated local pin_ai_incident_test database");
}

test("Channex booking uses the canonical incident, scoped host workspace and durable notice without a portal token", { skip: !enabled }, async () => {
  const prisma = new PrismaClient();
  const now = new Date();
  const org = await prisma.organization.create({ data: { name: "Synthetic channel incident" } });
  const property = await prisma.property.create({ data: { name: "Synthetic pilot", organizationId: org.id } });
  const bookingId = randomUUID(), threadId = randomUUID(), messageId = randomUUID(), leaseToken = randomUUID();
  const reservation = await prisma.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest",
    externalProvider: "CHANNEX", externalId: bookingId,
    checkIn: new Date(now.getTime() - 86400000), checkOut: new Date(now.getTime() + 86400000) } });
  const host = await prisma.dashboardUser.create({ data: { organizationId: org.id, email: `${randomUUID()}@example.test`,
    passwordHash: "not-a-login-credential", role: "ORG_ADMIN" } });
  const env = { PIN_AI_CHANNEX_AUTO_ENABLED: "true", PIN_AI_CHANNEX_AUTO_ORGANIZATION_IDS: org.id,
    PIN_AI_CHANNEX_AUTO_PROPERTY_IDS: property.id, PIN_AI_CHANNEX_AUTO_START_AT: now.toISOString(),
    APP_URL: "https://app.example.test", PIN_AI_HOST_INCIDENT_KEY_ID: "synthetic",
    PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ synthetic: "ab".repeat(32) }) };
  const scope = { organizationId: org.id, propertyId: property.id, threadId };
  const request: PinAIRuntimeRequest = { context: { organizationId: org.id, propertyId: property.id,
    reservationId: reservation.id, guestId: `channex-thread:${threadId}`, currentLocalDateTime: now.toISOString(), preferredLanguage: "es" },
    conversation: [{ role: "guest", content: "No sale agua caliente" }, { role: "assistant", content: "No hay electricidad" }] };
  const input = { prisma, request, env, now, channel: { bookingId, threadId, messageId },
    args: { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["No sale agua caliente"] } };
  try {
    await assert.rejects(handleGuestIncident(input), /CHANNEL_NOT_ACTIVE/);
    await prisma.channexAIThread.create({ data: { ...scope, since: now, leaseToken, leaseUntil: new Date(now.getTime() + 180000) } });
    await prisma.channexAIInbound.create({ data: { ...scope, messageId, status: "PROCESSING", leaseToken, leaseUntil: new Date(now.getTime() + 180000) } });
    await assert.rejects(handleGuestIncident({ ...input, guestToken: "cannot-impersonate-portal" }), /DISABLED/);
    await assert.rejects(handleGuestIncident({ ...input, channel: { ...input.channel, bookingId: "wrong-booking" } }), /SCOPE_INVALID/);
    await assert.rejects(handleGuestIncident({ ...input, request: { ...request, context: { ...request.context, organizationId: "other" } } }), /DISABLED/);
    await assert.rejects(handleGuestIncident({ ...input, args: { ...input.args, guestQuotes: ["No hay electricidad"] } }), /UNSUPPORTED_GUEST_QUOTE/);
    const receipts = await Promise.all([handleGuestIncident(input), handleGuestIncident(input)]);
    assert.equal(receipts[0]!.reference, receipts[1]!.reference);
    assert.equal(await prisma.operationalIssue.count({ where: { reservationId: reservation.id } }), 1);
    assert.equal(await prisma.messageLog.count({ where: { reservationId: reservation.id } }), 1);
    assert.equal((await prisma.channexAIThread.findFirstOrThrow({ where: scope })).mode, "AUTO");
    const hostInput = { prisma, env, actor: { id: host.id, orgId: org.id } };
    assert.equal((await listHostIncidents(hostInput)).items[0]!.reference, receipts[0]!.reference);
    assert.equal((await readHostIncident({ ...hostInput, reference: receipts[0]!.reference })).reservationNumber, reservation.reservationNumber);
    await assert.rejects(readHostIncident({ ...hostInput, actor: { id: host.id, orgId: "other" }, reference: receipts[0]!.reference }), /HOST_ACCESS_DENIED/);
    const notice = await prisma.messageLog.findFirstOrThrow({ where: { reservationId: reservation.id } });
    let sends = 0;
    const send = async () => { sends++; return "synthetic-provider-id"; };
    await Promise.all([1, 2].map(() => deliverGuestIncidentNotice({ prisma, message: notice, env, now, send })));
    assert.equal(sends, 1);
    await applyHostIncidentCommand({ ...hostInput, reference: receipts[0]!.reference,
      command: { operation: "ACKNOWLEDGE", text: "", expectedVersion: 0, requestId: "synthetic-ack-0001" } });
    const status = await handleGuestIncident({ ...input, args: { operation: "STATUS", category: "HOT_WATER", guestQuotes: [] } });
    assert.equal(status!.hostAcknowledged, true);
    assert.equal(status!.notification, "ACCEPTED");
    await applyHostIncidentCommand({ ...hostInput, reference: receipts[0]!.reference,
      command: { operation: "RESOLVE", text: "Synthetic resolution", expectedVersion: 1, requestId: "synthetic-resolve-0001" } });
    const replay = await handleGuestIncident(input);
    assert.equal(replay!.reference, receipts[0]!.reference);
    assert.equal(replay!.resolution, "RESOLVED");
    assert.equal(await prisma.messageLog.count({ where: { reservationId: reservation.id } }), 1);
    await prisma.channexAIThread.updateMany({ where: scope, data: { mode: "HUMAN" } });
    await assert.rejects(handleGuestIncident(input), /CHANNEL_NOT_ACTIVE/);
    await assert.rejects(listHostIncidents({ ...hostInput, env: { ...env, PIN_AI_CHANNEX_AUTO_ENABLED: "false" } }), /NOT_FOUND/);
  } finally {
    await prisma.channexAIInbound.deleteMany({ where: scope });
    await prisma.channexAIThread.deleteMany({ where: scope });
    await prisma.messageLog.deleteMany({ where: { reservationId: reservation.id } });
    await prisma.operationalIssueTransition.deleteMany({ where: { issue: { reservationId: reservation.id } } });
    await prisma.operationalIssue.deleteMany({ where: { reservationId: reservation.id } });
    await prisma.reservation.delete({ where: { id: reservation.id } });
    await prisma.dashboardUser.delete({ where: { id: host.id } });
    await prisma.property.delete({ where: { id: property.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
});

for (const hostRole of ["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"] as const) {
test(`PostgreSQL incident lifecycle with ${hostRole}: scoped recipients, atomic notice, deduplication and delivery`, { skip: !enabled }, async () => {
  const prisma = new PrismaClient();
  const now = new Date("2026-09-27T15:00:00Z");
  const org = await prisma.organization.create({ data: { name: "Synthetic incident test" } });
  const property = await prisma.property.create({ data: { name: "Synthetic property", organizationId: org.id } });
  const token = `synthetic-${randomUUID()}`;
  const reservation = await prisma.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest",
    guestToken: token, guestTokenExpiresAt: new Date("2026-10-01T00:00:00Z"),
    checkIn: new Date("2026-09-26T19:00:00Z"), checkOut: new Date("2026-09-28T15:00:00Z") } });
  const host = await prisma.dashboardUser.create({ data: { organizationId: org.id, email: `${randomUUID()}@example.test`, passwordHash: "not-a-login-credential", role: hostRole } });
  const otherOrg = await prisma.organization.create({ data: { name: "Unrelated recipient test" } });
  const request: PinAIRuntimeRequest = { context: { organizationId: org.id, propertyId: property.id, reservationId: reservation.id,
    guestId: "reservation-guest", currentLocalDateTime: "2026-09-27T11:00:00-04:00", preferredLanguage: "es" },
    conversation: [{ role: "guest", content: "Sí, en todos los grifos" }] };
  const env = { PIN_AI_INCIDENT_ENABLED: "true", PIN_AI_INCIDENT_CANARY_RESERVATION_IDS: reservation.id,
    PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED: "true", APP_URL: "https://app.example.test" };
  const base = { prisma, request, guestToken: token, env, now };
  const report = { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["El agua está fría", "en todos los grifos"] };
  try {
    // Production role compatibility must never widen tenant scope or include
    // inactive administrators or ordinary members in the outbox.
    for (const role of ["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN", "MEMBER"] as const) {
      await prisma.dashboardUser.create({ data: { organizationId: otherOrg.id,
        email: `${randomUUID()}@example.test`, passwordHash: "not-a-login-credential", role } });
      await prisma.dashboardUser.create({ data: { organizationId: org.id,
        email: `${randomUUID()}@example.test`, passwordHash: "not-a-login-credential", role, isActive: false } });
    }
    await prisma.dashboardUser.create({ data: { organizationId: org.id,
      email: `${randomUUID()}@example.test`, passwordHash: "not-a-login-credential", role: "MEMBER" } });
    await prisma.pinAIGuestConversation.create({ data: { reservationId: reservation.id,
      guestHistoryCiphertext: sealGuestHistory({ reservationId: reservation.id, guestToken: token }, "messages", [
        { id: "g-1", role: "guest", text: "El agua está fría" },
        { id: "a-1", role: "assistant", text: "Deja correr el agua varios minutos" },
      ]) } });
    await assert.rejects(handleGuestIncident({ ...base, guestToken: "wrong-token", args: report }), /SCOPE_INVALID/);
    await assert.rejects(handleGuestIncident({ ...base, request: { ...request, context: { ...request.context, organizationId: "wrong-org" } }, args: report }), /SCOPE_INVALID/);
    await assert.rejects(handleGuestIncident({ ...base, args: { ...report, guestQuotes: ["Deja correr el agua varios minutos"] } }), /UNSUPPORTED_GUEST_QUOTE/);
    assert.equal(await prisma.operationalIssue.count({ where: { reservationId: reservation.id } }), 0);
    const receipts = await Promise.all(Array.from({ length: 5 }, () => handleGuestIncident({ ...base, args: report })));
    assert.equal(new Set(receipts.map(r => r!.reference)).size, 1);
    assert.equal(await prisma.operationalIssue.count({ where: { reservationId: reservation.id } }), 1);
    assert.equal(await prisma.messageLog.count({ where: { reservationId: reservation.id } }), 1);
    const issue = await prisma.operationalIssue.findFirstOrThrow({ where: { reservationId: reservation.id } });
    assert.equal(await prisma.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1);
    assert.equal(issue.visibility, "HOST"); assert.equal(issue.workflowState, "ACTION_REQUIRED");
    assert.equal(issue.actionRequired, true); assert.doesNotMatch(issue.issue, /Deja correr/);
    const notice = await prisma.messageLog.findFirstOrThrow({ where: { reservationId: reservation.id } });
    assert.equal(notice.to, host.email);
    assert.equal(JSON.parse(notice.body!).retryPayload.dashboardPath, `/pin-ai/incidents/${receipts[0]!.reference}`);
    let sends = 0;
    const send = async () => { sends++; return `synthetic-provider-${randomUUID()}`; };
    await Promise.all([1, 2].map(() => deliverGuestIncidentNotice({ prisma, message: notice, env, now, send })));
    assert.equal(sends, 1);
    const statusArgs = { operation: "STATUS", category: "HOT_WATER", guestQuotes: [] };
    assert.equal((await handleGuestIncident({ ...base, args: statusArgs }))!.notification, "ACCEPTED");
    const sent = await prisma.messageLog.findUniqueOrThrow({ where: { id: notice.id } });
    await recordMessageDeliveryOutcome(prisma, { provider: "resend", providerMessageId: sent.providerMessageId!, status: "DELIVERED", eventAt: now, deliveredAt: now });
    assert.equal((await handleGuestIncident({ ...base, args: statusArgs }))!.notification, "DELIVERED");
    assert.equal((await handleGuestIncident({ ...base, args: statusArgs }))!.resolution, "OPEN");

    // A database failure inserting the notice must roll back the incident AND its transition.
    await prisma.$executeRawUnsafe(`ALTER TABLE "MessageLog" ADD CONSTRAINT incident_test_reject_notice CHECK ("communicationType" <> 'PIN_AI_GUEST_INCIDENT_HOST_NOTICE') NOT VALID`);
    try {
      await assert.rejects(handleGuestIncident({ ...base, args: { ...report, category: "OTHER" } }));
      assert.equal(await prisma.operationalIssue.count({ where: { reservationId: reservation.id } }), 1);
    } finally { await prisma.$executeRawUnsafe('ALTER TABLE "MessageLog" DROP CONSTRAINT incident_test_reject_notice'); }

    // Only persisted host/canonical resolution changes the result; STATUS never reopens it.
    await prisma.operationalIssue.update({ where: { id: issue.id }, data: { workflowState: "RESOLVED", actionRequired: false, resolvedAt: now } });
    assert.equal((await handleGuestIncident({ ...base, args: statusArgs }))!.resolution, "RESOLVED");
    assert.equal(await prisma.operationalIssue.count({ where: { reservationId: reservation.id } }), 1);
    const recurrence = await handleGuestIncident({ ...base, args: report });
    assert.notEqual(recurrence!.reference, receipts[0]!.reference);
    assert.equal(await prisma.operationalIssue.count({ where: { reservationId: reservation.id } }), 2);
    assert.equal(await prisma.messageLog.count({ where: { reservationId: reservation.id } }), 2);
    const accessCase = await handleGuestIncident({ ...base, args: { ...report, category: "ACCESS" } });
    assert.notEqual(accessCase!.reference, recurrence!.reference);
    // Exercise each revocation mechanism after a notice was already queued.
    await prisma.dashboardUser.update({ where: { id: host.id }, data:
      hostRole === "ORG_ADMIN" ? { isActive: false } :
      hostRole === "ADMIN" ? { role: "MEMBER" } : { organizationId: otherOrg.id } });
    const pending = await prisma.messageLog.findFirstOrThrow({ where: { reservationId: reservation.id, status: "QUEUED" } });
    await deliverGuestIncidentNotice({ prisma, message: pending, env, now, send: async () => assert.fail("revoked host must not receive notice") });
    assert.equal((await prisma.messageLog.findUniqueOrThrow({ where: { id: pending.id } })).status, "FAILED_FINAL");
    // No eligible recipient: keep the case and report attention, not success.
    const countBefore = await prisma.messageLog.count({ where: { reservationId: reservation.id } });
    const noRecipient = await handleGuestIncident({ ...base, args: { ...report, category: "CLEANLINESS" } });
    assert.equal(noRecipient!.notification, "ATTENTION_REQUIRED");
    assert.equal(noRecipient!.resolution, "OPEN");
    assert.equal(await prisma.messageLog.count({ where: { reservationId: reservation.id } }), countBefore);
  } finally {
    await prisma.messageLog.deleteMany({ where: { reservationId: reservation.id } });
    await prisma.operationalIssueTransition.deleteMany({ where: { issue: { reservationId: reservation.id } } });
    await prisma.operationalIssue.deleteMany({ where: { reservationId: reservation.id } });
    await prisma.reservation.delete({ where: { id: reservation.id } });
    await prisma.property.delete({ where: { id: property.id } });
    await prisma.dashboardUser.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.organization.delete({ where: { id: otherOrg.id } });
    await prisma.$disconnect();
  }
});
}
