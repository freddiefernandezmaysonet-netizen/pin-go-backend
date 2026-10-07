import assert from "node:assert/strict";
import test from "node:test";
import { runPinAIConnectBillingCycle } from "./fee-connect-cycle.service.js";
import type { ConnectDebitProvider } from "./fee-connect.service.js";
import { getPinAIFeeOverview } from "../services/pin-ai-activation.service.js";
import { recordPinAIReservationFee } from "./reservation-fee.service.js";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { setPinAIOrganization, setPinAIProperty } from "../services/pin-ai-activation.service.js";
import { handleGuestIncident } from "./guest/guest-incident.service.js";
import { deliverGuestIncidentNotice } from "./guest/guest-incident-notification.service.js";
import { listHostIncidents, readHostIncident, applyHostIncidentCommand } from "./host/host-incident.service.js";
import type { PinAIRuntimeRequest } from "./runtime/contracts.js";

const enabled = process.env.PIN_AI_ACTIVATION_DB_TEST === "true";
const url = new URL(process.env.DATABASE_URL ?? "http://missing");
if (enabled && (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/pin_ai_activation_test")) {
  throw new Error("Activation tests require the isolated local pin_ai_activation_test database");
}

test("persisted activation: fresh reservation, scoped incident, disable, history and atomic audit", { skip: !enabled }, async () => {
  const db = new PrismaClient();
  const now = new Date(Date.now() + 1000);
  const org = await db.organization.create({ data: { name: "Synthetic activation", stripeConnectAccountId: "acct_synthetic" } });
  const property = await db.property.create({ data: { name: "Synthetic property", organizationId: org.id } });
  const platform = await db.dashboardUser.create({ data: { organizationId: org.id, role: "PLATFORM_ADMIN",
    email: `${randomUUID()}@example.test`, passwordHash: "not-a-login-credential" } });
  const actor = { id: platform.id, orgId: org.id };
  const activationProvider = { eligibility: async () => ({ compatible: true, availableCents: 0 }) };
  const env = { PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: org.id, PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true", PIN_AI_GUEST_GATEWAY_ENABLED: "true", PIN_AI_RUNTIME_SHADOW_ENABLED: "true", PIN_AI_RUNTIME_REAL_READ_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_INCIDENT_ENABLED: "true",
    PIN_AI_HOST_INCIDENT_ENABLED: "true", PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED: "true",
    APP_URL: "https://app.example.test", PIN_AI_HOST_INCIDENT_KEY_ID: "synthetic",
    PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ synthetic: "ab".repeat(32) }) };
  await db.subscription.create({ data: { organizationId: org.id, status: "ACTIVE", stripeCustomerId: "cus_synthetic", stripeSubscriptionId: "sub_synthetic" } });
  const token = randomUUID();
  let reservationId: string | undefined;
  let noChatReservationId: string | undefined;
  try {
    await setPinAIOrganization(db, actor, org.id, { enabled: true, expectedRevision: 0 });
    await setPinAIProperty(db, env, actor, property.id, { enabled: true, expectedRevision: 0, organizationRevision: 1, acceptedTermsVersion: PIN_AI_BILLING_TERMS.version }, activationProvider);
    assert.equal(await db.apmsAuditEntry.count({ where: { organizationId: org.id, engine: "PIN_AI_ACTIVATION" } }), 2);
    await assert.rejects(setPinAIProperty(db, env, actor, property.id,
      { enabled: false, expectedRevision: 0, organizationRevision: 1 }), /CONFLICT/);
    const reservation = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest",
      source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT", guestToken: token, guestTokenExpiresAt: new Date(now.getTime() + 172800000),
      checkIn: new Date(now.getTime() - 86400000), checkOut: new Date(now.getTime() + 86400000) } });
    reservationId = reservation.id;
    const feeScope = { organizationId: org.id, propertyId: property.id, reservationId: reservation.id };
    assert.equal(await recordPinAIReservationFee(db, {}, feeScope, now), "DISABLED");
    assert.equal(await recordPinAIReservationFee(db, env, { ...feeScope, organizationId: "other" }, now), "DISABLED");
    assert.equal(await recordPinAIReservationFee(db, env, feeScope, new Date(reservation.checkIn.getTime() - 86400001)), "NOT_ELIGIBLE");
    await db.reservation.update({ where: { id: reservation.id }, data: { status: "CANCELLED" } });
    assert.equal(await recordPinAIReservationFee(db, env, feeScope, now), "NOT_ELIGIBLE");
    await db.reservation.update({ where: { id: reservation.id }, data: { status: "ACTIVE" } });
    assert.equal(await recordPinAIReservationFee(db, env, feeScope, now), "RECORDED");
    assert.equal(await recordPinAIReservationFee(db, env, feeScope, now), "ALREADY_RECORDED");
    const fee = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: reservation.id } });
    assert.equal(fee.amountCents, 100); assert.equal(fee.currency, "USD");
    assert.equal(fee.billingStatus, "PENDING_CONNECT");
    assert.equal(fee.acceptedBy, actor.id);
    assert.equal(fee.stripeConnectedAccountId, "acct_synthetic");
    let providerCreates = 0;
    let available = 100;
    const billingProvider: ConnectDebitProvider = {
      eligibility: async () => ({ compatible: true, availableCents: available }),
      create: async f => { providerCreates++; available -= 100;
        return { id: "py_synthetic", accountId: "acct_synthetic", amount: 100, currency: "usd",
          paid: true, status: "succeeded", metadata: { pinAIReservationId: f.reservationId,
            organizationId: f.organizationId, propertyId: f.propertyId, pinAITermsVersion: f.termsVersion } };
      }, retrieve: async () => { throw Error("unexpected"); },
    };
    await runPinAIConnectBillingCycle(db, billingProvider, env, now);
    assert.equal(providerCreates, 1);
    const paidFee = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: reservation.id } });
    assert.equal(paidFee.billingStatus, "PAID"); assert.ok(paidFee.paidAt);
    assert.equal((await getPinAIFeeOverview(db, actor)).totals[0].amountCents, 100);
    await assert.rejects(getPinAIFeeOverview(db, { ...actor, orgId: "other" }), /FORBIDDEN/);
    await runPinAIConnectBillingCycle(db, billingProvider, env, now);
    assert.equal(providerCreates, 1);
    const noChat = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic no chat",
      source: "MANUAL", guestToken: randomUUID(), guestTokenExpiresAt: new Date(now.getTime() + 3 * 86400000),
      checkIn: new Date(now.getTime() + 23 * 3600000), checkOut: new Date(now.getTime() + 2 * 86400000) } });
    noChatReservationId = noChat.id;
    const noChatCycle = await runPinAIConnectBillingCycle(db, billingProvider, env, now);
    assert.equal(noChatCycle.recorded, 1);
    const noChatFee = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: noChat.id } });
    assert.equal(noChatFee.amountCents, 100); assert.equal(noChatFee.billingStatus, "PENDING_BALANCE");
    assert.equal(providerCreates, 1, "no available Connect funds: no provider create");


    // Already accrued fees survive cancellation and a worker outage beyond
    // the guest window. Funding later settles that same obligation once.
    await db.reservation.update({ where: { id: noChat.id }, data: { status: "CANCELLED" } });
    available = 100;
    const originalCreate = billingProvider.create;
    billingProvider.create = async (f, k) => ({ ...await originalCreate(f, k), id: "py_nochat" });
    await runPinAIConnectBillingCycle(db, billingProvider, env, new Date(+now + 5 * 86400000));
    assert.equal(providerCreates, 2);
    assert.equal((await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: noChat.id } })).billingStatus, "PAID");
    await runPinAIConnectBillingCycle(db, billingProvider, env, new Date(+now + 6 * 86400000));
    assert.equal(providerCreates, 2);

    const request: PinAIRuntimeRequest = { context: { organizationId: org.id, propertyId: property.id,
      reservationId: reservation.id, guestId: "reservation-guest", currentLocalDateTime: now.toISOString(), preferredLanguage: "es" },
      conversation: [{ role: "guest", content: "No sale agua caliente" }] };
    const input = { prisma: db, env, now, request, guestToken: token,
      args: { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["No sale agua caliente"] } };
    const receipt = await handleGuestIncident(input);
    assert.ok(receipt);
    const hostInput = { prisma: db, env, actor };
    assert.equal((await listHostIncidents(hostInput)).items[0]?.reference, receipt.reference);
    await assert.rejects(readHostIncident({ ...hostInput, actor: { ...actor, orgId: "other-org" }, reference: receipt.reference }), /HOST_ACCESS_DENIED/);

    await setPinAIProperty(db, env, actor, property.id, { enabled: false, expectedRevision: 1, organizationRevision: 1 });
    await assert.rejects(handleGuestIncident(input), /DISABLED/);
    assert.equal((await listHostIncidents(hostInput)).items[0]?.reference, receipt.reference);
    const notice = await db.messageLog.findFirstOrThrow({ where: { reservationId } });
    let sends = 0;
    await deliverGuestIncidentNotice({ prisma: db, env, now, message: notice,
      send: async () => { sends++; return "synthetic-provider-id"; } });
    assert.equal(sends, 1, "already queued portal notice survives disable; provider is stubbed");
    await applyHostIncidentCommand({ ...hostInput, reference: receipt.reference,
      command: { operation: "ACKNOWLEDGE", text: "", expectedVersion: 0, requestId: "synthetic-ack-activation" } });

    await setPinAIOrganization(db, actor, org.id, { enabled: false, expectedRevision: 1 });
    assert.equal((await readHostIncident({ ...hostInput, reference: receipt.reference })).version, 1);
    await assert.rejects(setPinAIProperty(db, env, actor, property.id,
      { enabled: true, expectedRevision: 2, organizationRevision: 2, acceptedTermsVersion: PIN_AI_BILLING_TERMS.version }), /ORGANIZATION_NOT_ENABLED/);

    // Fail audit persistence inside the real SQL transaction; the setting must roll back too.
    const failingAuditDb = { $transaction: (callback: (tx: unknown) => Promise<unknown>, options: object) =>
      db.$transaction(tx => callback(new Proxy(tx, { get(target, key) {
        if (key === "apmsAuditEntry") return { create: async () => { throw new Error("synthetic-audit-failure"); } };
        return Reflect.get(target, key);
      } })), options) } as unknown as PrismaClient;
    await assert.rejects(setPinAIOrganization(failingAuditDb, actor, org.id, { enabled: true, expectedRevision: 2 }), /synthetic-audit-failure/);
    const saved = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    assert.equal(saved.pinAIEnabled, false); assert.equal(saved.pinAIRevision, 2);
    assert.equal(await db.apmsAuditEntry.count({ where: { organizationId: org.id, engine: "PIN_AI_ACTIVATION" } }), 4);
  } finally {
    await db.pinAIHostIncidentMessage.deleteMany({ where: { thread: { organizationId: org.id } } });
    await db.pinAIHostIncidentThread.deleteMany({ where: { organizationId: org.id } });
    await db.messageLog.deleteMany({ where: { organizationId: org.id } });
    await db.operationalIssueTransition.deleteMany({ where: { issue: { organizationId: org.id } } });
    await db.operationalIssue.deleteMany({ where: { organizationId: org.id } });
    await db.apmsAuditEntry.deleteMany({ where: { organizationId: org.id } });
    await db.pinAIReservationFee.deleteMany({ where: { organizationId: org.id } });
    if (noChatReservationId) await db.reservation.delete({ where: { id: noChatReservationId } });
    if (reservationId) await db.reservation.delete({ where: { id: reservationId } });
    await db.dashboardUser.delete({ where: { id: platform.id } });
    await db.property.delete({ where: { id: property.id } });
    await db.subscription.deleteMany({ where: { organizationId: org.id } });
    await db.organization.delete({ where: { id: org.id } });
    await db.$disconnect();
  }
});
