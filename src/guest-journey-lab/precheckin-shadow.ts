import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { assertLabEnvironment } from "./isolation";
import { planPrecheckinShadow, type PrecheckinSnapshot, type PrecheckinShadowObligation } from "./precheckin-shadow.policy";

// A controlled clock makes repeat/restart evidence comparable. This is not a
// claim that the real-world scheduler ran these reservations at the due time.
export const shadowNow = new Date("2030-05-01T16:00:00Z");
const hour = 3600000;
const consent = { consent: { smsConsent: true, acceptedAt: "2030-04-01T16:00:00Z" } };
const fixtures: Array<{ scenario: string; overrides?: Partial<PrecheckinSnapshot>; prior?: "email_sent" | "sms_unknown" }> = [
  { scenario: "direct_due" },
  { scenario: "no_consent", overrides: { externalRaw: null } },
  { scenario: "after_arrival", overrides: { checkIn: new Date(shadowNow.getTime() - hour) } },
  { scenario: "late_booking", overrides: { checkIn: new Date(shadowNow.getTime() - hour), createdAt: shadowNow } },
  { scenario: "before_window", overrides: { checkIn: new Date(shadowNow.getTime() + 5 * hour) } },
  { scenario: "unpaid", overrides: { paymentState: "NONE" } },
  { scenario: "cancelled", overrides: { status: "CANCELLED", cancelledAt: shadowNow } },
  { scenario: "checkout", overrides: { checkIn: new Date(shadowNow.getTime() - 24 * hour), checkOut: shadowNow } },
  { scenario: "missing_contacts", overrides: { guestEmail: null, guestPhone: null } },
  { scenario: "legacy_email", prior: "email_sent" },
  { scenario: "unknown_sms", prior: "sms_unknown" },
  { scenario: "airbnb", overrides: { source: "Airbnb", externalProvider: "CHANNEX", externalId: "11111111-1111-4111-8111-111111111111" } },
  { scenario: "booking_com", overrides: { source: "Booking.com", externalProvider: "CHANNEX", externalId: "22222222-2222-4222-8222-222222222222" } },
  { scenario: "ota_no_contacts", overrides: { source: "Airbnb", externalProvider: "CHANNEX", externalId: "33333333-3333-4333-8333-333333333333", guestEmail: null, guestPhone: null } },
];

export function shadowScope(revision: string) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(revision)) throw new Error("PRECHECKIN_SHADOW_REVISION_INVALID");
  return { organizationId: "gj_lab_organization", propertyId: `gj_lab_shadow_property_${revision}` };
}
const reservationId = (revision: string, scenario: string) => `gj_lab_${revision}_shadow_${scenario}`;

export async function preparePrecheckinShadow(db: PrismaClient) {
  assertLabEnvironment(process.env);
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS guest_journey_lab.precheckin_shadow (
    effect_key TEXT NOT NULL, fingerprint TEXT NOT NULL, fixture_revision TEXT NOT NULL,
    scenario TEXT NOT NULL, reservation_id TEXT NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), evidence JSONB NOT NULL,
    PRIMARY KEY(effect_key, fingerprint)
  )`);
}

export async function seedPrecheckinShadow(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = shadowScope(revision);
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(727361942)`;
    await tx.organization.upsert({ where: { id: scope.organizationId }, update: {}, create: {
      id: scope.organizationId, name: "Guest Journey Lab — synthetic only",
    } });
    await tx.property.upsert({ where: { id: scope.propertyId }, update: {}, create: {
      id: scope.propertyId, organizationId: scope.organizationId, name: "Synthetic pre-check-in shadow", timezone: "America/Puerto_Rico",
    } });
    for (const fixture of fixtures) {
      const id = reservationId(revision, fixture.scenario);
      if (await tx.reservation.findUnique({ where: { id } })) continue;
      const r = {
        status: "ACTIVE" as const, paymentState: "PAID" as const, cancelledAt: null,
        createdAt: new Date(shadowNow.getTime() - 24 * hour),
        checkIn: new Date(shadowNow.getTime() + 2 * hour), checkOut: new Date(shadowNow.getTime() + 48 * hour),
        guestEmail: "shadow@example.invalid", guestPhone: "+15005550006",
        source: "DIRECT_BOOKING", externalProvider: null, externalId: null, externalRaw: consent,
        ...fixture.overrides,
      };
      await tx.reservation.create({ data: {
        id, propertyId: scope.propertyId, guestName: "Synthetic shadow guest",
        guestEmail: r.guestEmail, guestPhone: r.guestPhone,
        status: r.status as "ACTIVE" | "CANCELLED", paymentState: r.paymentState as "PAID" | "NONE",
        cancelledAt: r.cancelledAt, createdAt: r.createdAt, checkIn: r.checkIn, checkOut: r.checkOut,
        source: r.source, externalProvider: r.externalProvider, externalId: r.externalId,
        externalRaw: r.externalRaw === null ? Prisma.DbNull : r.externalRaw as Prisma.InputJsonValue,
      } });
      // Only these two fixtures contain prior evidence. No fixture has a journey,
      // an executable intent or an APMS_PENDING outbox.
      if (fixture.prior === "email_sent") await tx.messageDispatchLog.create({ data: {
        reservationId: id, type: "PRECHECKIN", channel: "email", status: "SENT",
      } });
      if (fixture.prior === "sms_unknown") await tx.messageLog.create({ data: {
        id: `${id}_prior`, ...scope, reservationId: id, channel: "sms", provider: "twilio",
        to: "+15005550006", body: "SIMULATED prior uncertain result; never dispatch",
        communicationType: "PRECHECKIN", status: "E7_SENDING",
      } });
    }
  });
}

export async function runPrecheckinShadow(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = shadowScope(revision);
  let recorded = 0;
  for (const fixture of fixtures) {
    recorded += await db.$transaction(async tx => {
      const id = reservationId(revision, fixture.scenario);
      const r = await tx.reservation.findFirstOrThrow({ where: {
        id, propertyId: scope.propertyId, property: { organizationId: scope.organizationId },
      }, select: {
        id: true, propertyId: true, status: true, paymentState: true, cancelledAt: true,
        createdAt: true, checkIn: true, checkOut: true, guestEmail: true, guestPhone: true,
        source: true, externalProvider: true, externalId: true, externalRaw: true,
        messageDispatchLogs: { where: { type: "PRECHECKIN" }, select: { channel: true, status: true } },
      } });
      const messages = await tx.messageLog.findMany({ where: {
        ...scope, reservationId: id, communicationType: "PRECHECKIN",
      }, select: { channel: true, status: true } });
      const rows = planPrecheckinShadow({ ...r, organizationId: scope.organizationId }, shadowNow,
        { messages, dispatches: r.messageDispatchLogs }, process.env);
      let inserted = 0;
      for (const row of rows) {
        const evidence = JSON.stringify(row);
        const fingerprint = createHash("sha256").update(evidence).digest("hex");
        inserted += await tx.$executeRaw`INSERT INTO guest_journey_lab.precheckin_shadow
          (effect_key, fingerprint, fixture_revision, scenario, reservation_id, evaluated_at, evidence)
          VALUES (${row.effectKey}, ${fingerprint}, ${revision}, ${fixture.scenario}, ${id}, ${shadowNow}, ${evidence}::jsonb)
          ON CONFLICT(effect_key, fingerprint) DO NOTHING`;
      }
      return inserted;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  return { mode: "SHADOW", clockMode: "FIXED_SYNTHETIC", reservations: fixtures.length, recorded, providerCalls: 0 };
}

export async function readPrecheckinShadow(db: PrismaClient, revision: string) {
  assertLabEnvironment(process.env);
  const scope = shadowScope(revision);
  const observations = await db.$queryRaw<Array<{ scenario: string; reservationId: string; evidence: PrecheckinShadowObligation }>>`
    SELECT scenario, reservation_id AS "reservationId", evidence
    FROM guest_journey_lab.precheckin_shadow WHERE fixture_revision = ${revision}
    ORDER BY scenario, effect_key, fingerprint`;
  const executableIntents = await db.guestJourneyCoordinationIntent.count({ where: { reservation: { propertyId: scope.propertyId } } });
  const dispatchableMessages = await db.messageLog.count({ where: { ...scope, status: { in: ["APMS_PENDING", "FAILED"] } } });
  const calls = await db.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count
    FROM guest_journey_lab.provider_call c JOIN "MessageLog" m ON m.id = c.message_id
    WHERE m."organizationId" = ${scope.organizationId} AND m."propertyId" = ${scope.propertyId}`;
  return {
    mode: "SHADOW", clockMode: "FIXED_SYNTHETIC", evaluatedAt: shadowNow,
    executableIntents, dispatchableMessages, providerCalls: calls[0].count, deliveryCertified: false,
    observations,
  };
}
