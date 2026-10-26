import { PrismaClient, Prisma } from "@prisma/client";
import { materializeGuestJourneyCoordinationIntents } from "../services/guest-journey-coordination-intent.service";
import { runGuestJourneyCommunicationsOwnerCycle } from "../services/guest-journey-communications-owner-cycle.service";
import { executeGuestJourneyCommunicationDeliveryAdapter } from "../services/guest-journey-communications-delivery-adapter.service";
import { recordMessageDeliveryOutcome } from "../services/guest-journey-communications-delivery-outcome.service";

export const prisma = new PrismaClient();
const organizationId = "gj_lab_organization";
const propertyId = "gj_lab_property";
const scope = { organizationId, propertyId };
const scenarios = ["accepted", "empty_ack", "timeout", "ota_channel"] as const;

export async function prepareLabTables(): Promise<void> {
  await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS guest_journey_lab');
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS guest_journey_lab.provider_call (
    id BIGSERIAL PRIMARY KEY, message_id TEXT NOT NULL, scenario TEXT NOT NULL,
    provider_id TEXT, attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS guest_journey_lab.heartbeat (
    role TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
    details JSONB NOT NULL
  )`);
}

/** Seed once. Restarting must preserve claims, receipts and call counts. */
export async function seedLabFixtures(): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(727361941)`;
    await tx.organization.upsert({ where: { id: organizationId }, update: {}, create: {
      id: organizationId, name: "Guest Journey Lab — synthetic only",
    } });
    await tx.property.upsert({ where: { id: propertyId }, update: {}, create: {
      id: propertyId, organizationId, name: "Synthetic test property", timezone: "America/Puerto_Rico",
    } });
    for (const scenario of scenarios) {
      const reservationId = `gj_lab_${scenario}`;
      if (await tx.reservation.findUnique({ where: { id: reservationId } })) continue;
      const now = Date.now();
      await tx.reservation.create({ data: {
        id: reservationId, propertyId, guestName: "Synthetic Guest",
        guestEmail: `${scenario}@example.invalid`, guestPhone: "+15005550006",
        checkIn: new Date(now + 24 * 60 * 60_000), checkOut: new Date(now + 48 * 60 * 60_000),
        status: "ACTIVE", paymentState: "PAID",
        source: scenario === "ota_channel" ? "Airbnb" : "DIRECT_BOOKING",
        ...(scenario === "ota_channel" ? {
          externalProvider: "CHANNEX", externalId: "11111111-1111-4111-8111-111111111111",
        } : {}),
        guestJourney: { create: {} },
      } });
      await tx.messageLog.create({ data: {
        id: `gj_lab_message_${scenario}`, ...scope, reservationId,
        channel: "sms", communicationType: "PRECHECKIN", provider: "twilio",
        to: "+15005550006", body: "SIMULATION ONLY: synthetic pre-check-in notice",
        status: "APMS_PENDING",
      } });
    }
  });
  // Real E4 creates intents from the fixture outbox. This does not prove that
  // reservation events generate every required first-send obligation.
  for (const scenario of scenarios) {
    const reservationId = `gj_lab_${scenario}`;
    const existing = await prisma.guestJourneyCoordinationIntent.count({ where: {
      reservationId, targetEngine: "COMMUNICATIONS",
    } });
    if (!existing) await materializeGuestJourneyCoordinationIntents(prisma, reservationId, { scope });
  }
}

export async function heartbeat(role: string, details: Prisma.InputJsonValue): Promise<void> {
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA ?? "local";
  await prisma.$executeRaw`INSERT INTO guest_journey_lab.heartbeat(role, commit_sha, observed_at, details)
    VALUES (${role}, ${commit}, NOW(), ${JSON.stringify(details)}::jsonb)
    ON CONFLICT(role) DO UPDATE SET commit_sha=EXCLUDED.commit_sha,
      observed_at=EXCLUDED.observed_at, details=EXCLUDED.details`;
}

export async function runCommunicationsProbe(): Promise<unknown> {
  const metrics = await runGuestJourneyCommunicationsOwnerCycle(prisma, {
    enabled: true, organizationIds: [organizationId], propertyIds: [propertyId],
    batchSize: 10, leaseMs: 60_000, maxClaims: 3, retryBaseMs: 30_000, providerTimeoutMs: 1_000,
  }, { dependencies: {
    execute: async (db, claim, options) => {
      const messageId = String(claim.payload.messageLogId);
      const scenario = scenarios.find(value => claim.reservationId === `gj_lab_${value}`);
      if (!scenario || messageId !== `gj_lab_message_${scenario}`) {
        throw new Error("GJ_LAB_UNKNOWN_FIXTURE_REJECTED");
      }
      const send = async () => {
        const providerId = scenario === "accepted" ? `LAB_${messageId}` : null;
        await prisma.$executeRaw`INSERT INTO guest_journey_lab.provider_call(message_id, scenario, provider_id)
          VALUES (${messageId}, ${scenario}, ${providerId})`;
        if (scenario === "timeout") return new Promise<never>(() => {});
        if (scenario === "empty_ack") return {};
        if (scenario === "ota_channel") throw new Error("GJ_LAB_OTA_ROUTING_REGRESSION");
        return { sid: providerId };
      };
      return executeGuestJourneyCommunicationDeliveryAdapter(db, claim, options, {
        sendSms: send as never,
        sendEmail: async () => { throw new Error("GJ_LAB_UNEXPECTED_EMAIL_HANDLER"); },
      });
    },
  } });
  const accepted = await prisma.messageLog.findUnique({ where: { id: "gj_lab_message_accepted" } });
  if (accepted?.providerMessageId && accepted.providerDeliveryStatus !== "DELIVERED") {
    await recordMessageDeliveryOutcome(prisma, {
      provider: "twilio", providerMessageId: accepted.providerMessageId,
      status: "DELIVERED", eventAt: new Date(), deliveredAt: new Date(),
    });
  }
  await heartbeat("communications", metrics);
  return metrics;
}

export async function readLabEvidence() {
  const [messages, intents, calls, workers, issues, attempts] = await Promise.all([
    prisma.messageLog.findMany({ where: { organizationId, propertyId }, orderBy: { id: "asc" }, select: {
      id: true, status: true, providerMessageId: true, providerDeliveryStatus: true,
      deliveredAt: true, retryCount: true, error: true,
    } }),
    prisma.guestJourneyCoordinationIntent.findMany({ where: {
      targetEngine: "COMMUNICATIONS", reservation: { propertyId },
    }, orderBy: { createdAt: "asc" }, select: {
      id: true, reservationId: true, intentType: true, status: true, claimCount: true,
      leaseExpiresAt: true, nextActionAt: true, succeededAt: true, lastError: true,
    } }),
    prisma.$queryRaw<Array<{ scenario: string; calls: number }>>`SELECT scenario, COUNT(*)::int AS calls
      FROM guest_journey_lab.provider_call GROUP BY scenario ORDER BY scenario`,
    prisma.$queryRaw<Array<{ role: string; commit_sha: string; observed_at: Date; details: unknown }>>`
      SELECT role, commit_sha, observed_at, details FROM guest_journey_lab.heartbeat ORDER BY role`,
    prisma.operationalIssue.count({ where: { organizationId, propertyId } }),
    prisma.guestJourneyCoordinationIntentAttempt.count({ where: { intent: { reservation: { propertyId } } } }),
  ]);
  return {
    mode: "SIMULATION_ONLY", productionReady: false, externalProviderCallsAllowed: false,
    coverage: "E4/E7 outbox, claims, simulated send, callback persistence and replay; not full reservation certification",
    knownGaps: ["timeout recovery", "all-event first-send parity", "delivery-gated completion", "host Mission Control parity"],
    messages, intents, calls, workers, operationalIssues: issues, durableAttempts: attempts,
  };
}
