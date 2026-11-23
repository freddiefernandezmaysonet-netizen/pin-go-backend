import { retainLabReceipt, replayLabReceipts, readLabReceiptInbox } from "./receipt-inbox";
import { Prisma, type PrismaClient } from "@prisma/client";
import { assertLabEnvironment } from "./isolation";
import { firstSendScope, firstSendReservationId, materializeFirstPrecheckin } from "./precheckin-first-send";
import { runGuestJourneyCommunicationsOwnerCycle } from "../services/guest-journey-communications-owner-cycle.service";
import { executeGuestJourneyCommunicationDeliveryAdapter } from "../services/guest-journey-communications-delivery-adapter.service";
import { recordMessageDeliveryOutcome } from "../services/guest-journey-communications-delivery-outcome.service";
import { reconcileGuestJourneyCommunicationEvidence } from "../services/guest-journey-communications-recovery.service";

export const firstSendScenarios = ["before_arrival", "after_arrival", "late_booking", "late_consent", "ota", "cancelled", "legacy_email", "uncertain_prior", "withdrawn_consent"] as const;
const consent = { consent: { smsConsent: true, acceptedAt: "2026-01-01T00:00:00Z" } };

export async function seedFirstSend(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = firstSendScope(revision);
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(727361943)`;
    const anchor = new Date();
    const property = await tx.property.upsert({ where: { id: scope.propertyId }, update: {}, create: {
      id: scope.propertyId, organizationId: scope.organizationId, name: "Synthetic first-send property",
      timezone: "America/Puerto_Rico", createdAt: anchor, isTestProperty: true,
      address1: "Synthetic arrival address", complexName: "Synthetic complex", unitNumber: "TEST",
    } });
    const time = property.createdAt.getTime();
    for (const scenario of firstSendScenarios) {
      const id = firstSendReservationId(revision, scenario);
      if (await tx.reservation.findUnique({ where: { id } })) continue;
      await tx.reservation.create({ data: {
        id, propertyId: scope.propertyId, guestName: "Synthetic first-send guest",
        guestEmail: `${scenario}@example.invalid`, guestPhone: "+15005550006", preferredLanguage: "es",
        status: scenario === "cancelled" ? "CANCELLED" : "ACTIVE", paymentState: "PAID",
        createdAt: new Date(time - (scenario === "late_booking" ? 0 : 86400000)),
        checkIn: new Date(time + (["after_arrival", "late_booking"].includes(scenario) ? -3600000 : 3600000)),
        checkOut: new Date(time + 86400000),
        source: scenario === "ota" ? "Airbnb" : "DIRECT_BOOKING",
        ...(scenario === "ota" ? { externalProvider: "CHANNEX", externalId: "11111111-1111-4111-8111-111111111111" } : {}),
        externalRaw: scenario === "late_consent" ? Prisma.DbNull : consent,
        guestJourney: { create: {} },
      } });
      if (scenario === "legacy_email") await tx.messageDispatchLog.create({ data: {
        reservationId: id, type: "PRECHECKIN", channel: "email", status: "SENT",
      } });
      if (scenario === "uncertain_prior") await tx.messageLog.create({ data: {
        id: `${id}_prior`, ...scope, reservationId: id, communicationType: "PRECHECKIN", channel: "sms",
        to: "+15005550006", provider: "twilio", body: "Synthetic uncertain prior SMS; do not resend", status: "E7_SENDING",
      } });
    }
  });
}

export async function materializeFirstSendFixtures(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = firstSendScope(revision);
  const property = await db.property.findUniqueOrThrow({ where: { id: scope.propertyId } });
  const results = [];
  for (const scenario of firstSendScenarios) results.push({ scenario,
    decisions: await materializeFirstPrecheckin(db, revision, firstSendReservationId(revision, scenario), property.createdAt),
  });
  return results;
}

export async function dispatchFirstSend(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = firstSendScope(revision);
  const property = await db.property.findUniqueOrThrow({ where: { id: scope.propertyId } });
  // Synthetic consent withdrawal after materialization but before delivery.
  await db.reservation.update({ where: { id: firstSendReservationId(revision, "withdrawn_consent") },
    data: { externalRaw: { consent: { smsConsent: false } } } });
  return runGuestJourneyCommunicationsOwnerCycle(db, {
    enabled: true, organizationIds: [scope.organizationId], propertyIds: [scope.propertyId],
    batchSize: 30, leaseMs: 60000, maxClaims: 3, retryBaseMs: 30000, providerTimeoutMs: 1000,
  }, { dependencies: { execute: async (client, claim, options) => {
    const messageId = String(claim.payload.messageLogId);
    const scenario = firstSendScenarios.find(s => claim.reservationId === firstSendReservationId(revision, s));
    if (!scenario || !messageId.startsWith("gjfirst_")) throw Error("FIRST_SEND_UNKNOWN_FIXTURE");
    const send = async () => {
      const providerId = `LAB_FIRST_${messageId}`;
      await db.$executeRaw`INSERT INTO guest_journey_lab.provider_call(message_id, scenario, provider_id)
        VALUES (${messageId}, ${`first_${scenario}`}, ${providerId})`;
      if (scenario === "before_arrival") {
        // Simulate delivery before the adapter can persist the provider ID.
        const eventAt = new Date();
        await retainLabReceipt(db, scope, { provider: String(claim.payload.channel).toLowerCase() === "email" ? "resend" : "twilio",
          providerMessageId: providerId, status: "DELIVERED", eventAt, deliveredAt: eventAt });
      }
      return { id: providerId, sid: providerId, status: "queued" as const };
    };
    return executeGuestJourneyCommunicationDeliveryAdapter(client, claim,
      { ...options, now: property.createdAt, firstSendContract: "PRECHECKIN_DELIVERY_V1" }, { sendSms: send, sendEmail: send });
  } } });
}

export async function advanceFirstSendConsent(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = firstSendScope(revision);
  const reservationId = firstSendReservationId(revision, "late_consent");
  const email = await db.messageLog.findFirst({ where: { ...scope, reservationId, channel: "email", status: "E7_SENDING" } });
  if (email) await db.reservation.update({ where: { id: reservationId }, data: { externalRaw: consent } });
}

export async function receiveFirstSendReceipts(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = firstSendScope(revision);
  await replayLabReceipts(db, scope);
  const messages = await db.messageLog.findMany({ where: { ...scope, id: { startsWith: "gjfirst_" }, providerMessageId: { not: null } } });
  for (const message of messages) {
    if (message.providerDeliveryStatus === "DELIVERED") continue;
    // No fallback receipt may conceal a failed early-receipt replay.
    if (message.reservationId === firstSendReservationId(revision, "before_arrival")) continue;
    if (message.provider !== "twilio" && message.provider !== "resend") throw Error("FIRST_SEND_PROVIDER_INVALID");
    const eventAt = new Date();
    await recordMessageDeliveryOutcome(db, { provider: message.provider, providerMessageId: message.providerMessageId!,
      status: "DELIVERED", eventAt, deliveredAt: eventAt });
  }
  const intents = await db.guestJourneyCoordinationIntent.findMany({ where: {
    targetEngine: "COMMUNICATIONS", status: "WAITING_FOR_EVIDENCE", reservation: { propertyId: scope.propertyId },
  }, select: { id: true } });
  for (const intent of intents) await reconcileGuestJourneyCommunicationEvidence(db, { ...scope, intentId: intent.id });
}

export async function runFirstSendProbe(db: PrismaClient, revision: string) {
  const materialization = await materializeFirstSendFixtures(db, revision);
  const dispatch = await dispatchFirstSend(db, revision);
  await advanceFirstSendConsent(db, revision);
  await receiveFirstSendReceipts(db, revision);
  return { materialization, dispatch, simulationOnly: true };
}

export async function readFirstSendEvidence(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = firstSendScope(revision);
  const [messages, intents, attempts, audit, calls, issues] = await Promise.all([
    db.messageLog.findMany({ where: scope, orderBy: { id: "asc" }, select: { id: true, reservationId: true, channel: true,
      status: true, provider: true, providerMessageId: true, providerDeliveryStatus: true, deliveredAt: true, retryCount: true } }),
    db.guestJourneyCoordinationIntent.findMany({ where: { reservation: { propertyId: scope.propertyId } }, orderBy: { id: "asc" },
      select: { id: true, reservationId: true, targetEngine: true, payload: true, status: true, claimCount: true, lastError: true } }),
    db.guestJourneyCoordinationIntentAttempt.findMany({ where: { intent: { reservation: { propertyId: scope.propertyId } } },
      orderBy: { id: "asc" }, select: { id: true, intentId: true, outcome: true, attemptNumber: true, leaseTokenFingerprint: true } }),
    db.apmsAuditEntry.findMany({ where: scope, orderBy: { decisionId: "asc" }, select: { decisionId: true, reason: true, metadata: true } }),
    db.$queryRaw<Array<{ messageId: string; calls: number }>>`SELECT c.message_id AS "messageId", COUNT(*)::int AS calls
      FROM guest_journey_lab.provider_call c JOIN "MessageLog" m ON m.id=c.message_id
      WHERE m."propertyId"=${scope.propertyId} AND m."organizationId"=${scope.organizationId}
      GROUP BY c.message_id ORDER BY c.message_id`,
    db.operationalIssue.findMany({ where: scope, orderBy: { id: "asc" }, select: { id: true, workflowState: true, visibility: true, issueCode: true } }),
  ]);
  return { mode: "SIMULATED_FIRST_SEND", clockMode: "FIXED_AT_FIXTURE_CREATION", realDeliveryCertified: false,
    legacyCoexistenceCertified: false, receiptInbox: await readLabReceiptInbox(db, scope),
    messages, intents, attempts, audit, calls, issues };
}

