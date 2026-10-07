import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { channelPropertyEnabled, channelActivationSince } from "../channex-messaging/pin-ai-commercial.policy.js";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";
import { recordPinAIReservationFee } from "./reservation-fee.service.js";
import { collectPinAIConnectFee, type ConnectDebitProvider } from "./fee-connect.service.js";
import { handleGuestIncident } from "./guest/guest-incident.service.js";
import { deliverGuestIncidentNotice } from "./guest/guest-incident-notification.service.js";
import { listHostIncidents, readHostIncident } from "./host/host-incident.service.js";
import type { PinAIRuntimeRequest } from "./runtime/contracts.js";

const enabled = process.env.PIN_AI_NATIVE_DB_TEST === "true";
const url = new URL(process.env.DATABASE_URL ?? "http://missing");
if (enabled && (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/pin_ai_activation_test"))
  throw Error("Commercial OTA tests require isolated localhost pin_ai_activation_test");

test("PostgreSQL: globally activated OTA property, one fee, incident and retained host history", { skip: !enabled }, async () => {
  const db = new PrismaClient(), now = new Date(), acceptedAt = new Date(+now - 10000);
  const org = await db.organization.create({ data: { name: "Synthetic commercial OTA", pinAIEnabled: true,
    pinAIRevision: 1, stripeConnectAccountId: `acct_${randomUUID().replaceAll("-", "")}` } });
  const property = await db.property.create({ data: { name: "Synthetic commercial OTA", organizationId: org.id,
    pinAIEnabled: true, pinAIRevision: 1, pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
    pinAITermsAcceptedAt: acceptedAt, pinAITermsAcceptedBy: "synthetic-host" } });
  const bookingId = randomUUID(), threadId = randomUUID(), messageId = randomUUID(), leaseToken = randomUUID();
  const reservation = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic OTA guest",
    externalProvider: "CHANNEX", externalId: bookingId, source: "Airbnb",
    checkIn: new Date(+now - 3600000), checkOut: new Date(+now + 86400000) } });
  const host = await db.dashboardUser.create({ data: { organizationId: org.id, email: `${randomUUID()}@example.test`,
    passwordHash: "synthetic-not-a-credential", role: "ORG_ADMIN" } });
  const env = { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true",
    PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
    PIN_AI_CHANNEX_AUTO_ENABLED: "true", PIN_AI_CHANNEX_AUTO_START_AT: new Date(+now - 20000).toISOString(),
    PIN_AI_INCIDENT_ENABLED: "true", PIN_AI_HOST_INCIDENT_ENABLED: "true", PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED: "true",
    APP_URL: "https://app.example.test", PIN_AI_HOST_INCIDENT_KEY_ID: "synthetic",
    PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ synthetic: "ab".repeat(32) }) };
  const scope = { organizationId: org.id, propertyId: property.id, reservationId: reservation.id };
  try {
    await db.apmsAuditEntry.create({ data: { organizationId: org.id, propertyId: property.id, entityType: "PROPERTY",
      entityId: property.id, engine: "PIN_AI_ACTIVATION", eventType: "SET_ENABLED", status: "APPLIED",
      decisionId: `pin-ai-activation:property:${property.id}:1`, summary: "Synthetic activation", createdAt: acceptedAt,
      metadata: { enabled: true, revision: 1 } } });
    assert.equal(await channelPropertyEnabled(db, env, scope), true);
    assert.equal(+(await channelActivationSince(db, env, scope))!, +acceptedAt);
    assert.equal(await channelPropertyEnabled(db, env, { ...scope, organizationId: "other-tenant" }), false);
    assert.equal(await recordPinAIReservationFee(db, env, scope, now), "RECORDED");
    assert.equal(await recordPinAIReservationFee(db, env, scope, now), "ALREADY_RECORDED");
    let debits = 0;
    const provider: ConnectDebitProvider = { eligibility: async () => ({ compatible: true, availableCents: 100 }),
      create: async fee => { debits++; return { id: `py_${reservation.id}`, accountId: fee.stripeConnectedAccountId!,
        amount: 100, currency: "usd", paid: true, status: "succeeded", metadata: { pinAIReservationId: reservation.id,
          organizationId: org.id, propertyId: property.id, pinAITermsVersion: PIN_AI_BILLING_TERMS.version } }; },
      retrieve: async () => { throw Error("paid replay must not contact provider"); } };
    await db.property.update({ where: { id: property.id }, data: { pinAIFeeExempt: true } });
    assert.equal(await channelPropertyEnabled(db, env, scope), true);
    assert.equal(await recordPinAIReservationFee(db, env, scope, now), "EXEMPT");
    assert.equal(await collectPinAIConnectFee(db, provider, env, reservation.id, now), "EXEMPT");
    assert.equal(debits, 0);
    await db.property.update({ where: { id: property.id }, data: { pinAIFeeExempt: false } });
    assert.equal(await collectPinAIConnectFee(db, provider, env, reservation.id, now), "PAID");
    assert.equal(await collectPinAIConnectFee(db, provider, env, reservation.id, now), "PAID");
    assert.equal(debits, 1);
    await db.channexAIThread.create({ data: { organizationId: org.id, propertyId: property.id, threadId,
      since: acceptedAt, leaseToken, leaseUntil: new Date(+now + 180000) } });
    await db.channexAIInbound.create({ data: { organizationId: org.id, propertyId: property.id, threadId,
      messageId, status: "PROCESSING", leaseToken, leaseUntil: new Date(+now + 180000) } });
    const request: PinAIRuntimeRequest = { context: { ...scope, guestId: `channex-thread:${threadId}`,
      currentLocalDateTime: now.toISOString(), preferredLanguage: "es" },
      conversation: [{ role: "guest", content: "No sale agua caliente" }] };
    const input = { prisma: db, request, env, now, channel: { bookingId, threadId, messageId },
      args: { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["No sale agua caliente"] } };
    const receipt = await handleGuestIncident(input); assert.ok(receipt);
    assert.equal((await handleGuestIncident(input))!.reference, receipt.reference);
    assert.equal(await db.operationalIssue.count({ where: { reservationId: reservation.id } }), 1);
    const hostInput = { prisma: db, env, actor: { id: host.id, orgId: org.id } };
    assert.equal((await listHostIncidents(hostInput)).items[0]!.reference, receipt.reference);
    await db.property.update({ where: { id: property.id }, data: { pinAIEnabled: false, pinAIRevision: 2 } });
    assert.equal(await channelPropertyEnabled(db, env, scope), false);
    await assert.rejects(handleGuestIncident(input), /DISABLED/);
    assert.equal((await readHostIncident({ ...hostInput, reference: receipt.reference })).destination, "CHANNEL");
    assert.equal((await listHostIncidents(hostInput)).items[0]!.reference, receipt.reference);
    const notice = await db.messageLog.findFirstOrThrow({ where: { reservationId: reservation.id } });
    let notices = 0;
    assert.equal(await deliverGuestIncidentNotice({ prisma: db, message: notice, env, now,
      send: async () => { notices++; return "synthetic-provider-notice"; } }), "ACCEPTED");
    assert.equal(notices, 1);
    assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: reservation.id } }), 1);
  } finally {
    await db.messageLog.deleteMany({ where: { organizationId: org.id } });
    await db.operationalIssue.deleteMany({ where: { organizationId: org.id } });
    await db.channexAIInbound.deleteMany({ where: { organizationId: org.id } });
    await db.channexAIThread.deleteMany({ where: { organizationId: org.id } });
    await db.pinAIReservationFee.deleteMany({ where: { organizationId: org.id } });
    await db.apmsAuditEntry.deleteMany({ where: { organizationId: org.id } });
    await db.reservation.delete({ where: { id: reservation.id } });
    await db.dashboardUser.delete({ where: { id: host.id } });
    await db.property.delete({ where: { id: property.id } });
    await db.organization.delete({ where: { id: org.id } });
    await db.$disconnect();
  }
});
