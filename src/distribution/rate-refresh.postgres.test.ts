import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { runRateRefreshCycle } from "./rate-refresh.service.js";

const connection = process.env.RATE_REFRESH_POSTGRES_TEST_URL;
test("Postgres: competing workers, persistent replay, cancellation, rollover and transaction rollback", {
  skip: !connection,
}, async () => {
  const url = new URL(connection!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const schema = `rate_refresh_${randomUUID().replaceAll("-", "")}`;
  const admin = new PrismaClient({ datasourceUrl: url.toString() });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("schema", schema);
  const a = new PrismaClient({ datasourceUrl: url.toString() });
  const b = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const fixture = [
      `CREATE TYPE "PmsProvider" AS ENUM ('CHANNEX')`,
      `CREATE TYPE "PmsConnectionStatus" AS ENUM ('ACTIVE','DISABLED','ERROR')`,
      `CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE','CANCELLED')`,
      `CREATE TABLE "Property" (id text PRIMARY KEY, "organizationId" text NOT NULL,
        timezone text, status text DEFAULT 'ACTIVE', "distributionEnabled" boolean DEFAULT true,
        "distributionStatus" text DEFAULT 'ACTIVE', "baseNightlyRate" numeric DEFAULT 100,
        "minimumNightlyRate" numeric, "maximumNightlyRate" numeric,
        "dynamicPricingEnabled" boolean DEFAULT true, "seasonalPricingEnabled" boolean DEFAULT false,
        "holidayPricingEnabled" boolean DEFAULT false, "weekendMarkupPercent" numeric DEFAULT 0,
        "leadTimePricingEnabled" boolean DEFAULT true, "leadTimeLastMinuteDays" int DEFAULT 3,
        "leadTimeLastMinutePercent" numeric DEFAULT -10, "occupancyPricingEnabled" boolean DEFAULT true,
        "occupancyLookaheadDays" int DEFAULT 30, "occupancyLowThresholdPercent" numeric DEFAULT 40,
        "occupancyLowAdjustmentPercent" numeric DEFAULT -5, "occupancyHighThresholdPercent" numeric DEFAULT 80,
        "occupancyHighAdjustmentPercent" numeric DEFAULT 10)`,
      `CREATE TABLE "PmsConnection" (id text PRIMARY KEY, "organizationId" text NOT NULL,
        provider "PmsProvider" NOT NULL, status "PmsConnectionStatus" NOT NULL,
        UNIQUE ("organizationId",provider))`,
      `CREATE TABLE "PmsListing" (id text PRIMARY KEY, "connectionId" text NOT NULL,
        "propertyId" text, "externalListingId" text NOT NULL, metadata jsonb)`,
      `CREATE TABLE "Reservation" (id text PRIMARY KEY, "propertyId" text NOT NULL,
        status "ReservationStatus" NOT NULL, "checkIn" timestamp(3) NOT NULL, "checkOut" timestamp(3) NOT NULL)`,
    ];
    for (const statement of fixture) await a.$executeRawUnsafe(statement);
    for (const migration of ["20260728011000_add_channex_outbound_ari", "20260808120000_add_channex_ari_changed_fields"]) {
      const sql = await readFile(new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
      for (const raw of sql.split(";")) {
        const statement = raw.replace(/^\s*--.*$/gm, "").trim();
        if (statement && statement !== "BEGIN" && statement !== "COMMIT") await a.$executeRawUnsafe(statement);
      }
    }
    await a.$executeRaw`INSERT INTO "Property" (id,"organizationId",timezone) VALUES ('p-a','org-a','America/Puerto_Rico')`;
    await a.$executeRaw`INSERT INTO "PmsConnection" (id,"organizationId",provider,status) VALUES ('c-a','org-a','CHANNEX','ACTIVE')`;
    await a.$executeRaw`INSERT INTO "PmsListing" (id,"connectionId","propertyId","externalListingId",metadata)
      VALUES ('l-a','c-a','p-a','room-a','{"provider":"CHANNEX","channexPropertyId":"external-a","channexRatePlanId":"rate-a"}')`;
    const now = new Date("2026-10-12T21:00:00Z");
    const runs = await Promise.all([runRateRefreshCycle(a, now), runRateRefreshCycle(b, now)]);
    assert.equal(runs.reduce((sum, r) => sum + r.enqueued, 0), 2);
    assert.equal(await a.distributionOutboxEvent.count(), 2);
    assert.equal((await runRateRefreshCycle(b, now)).enqueued, 0);

    await a.$executeRaw`INSERT INTO "Reservation" (id,"propertyId",status,"checkIn","checkOut")
      VALUES ('r-a','p-a','ACTIVE','2026-10-13T20:00:00','2026-10-15T15:00:00')`;
    assert.equal((await runRateRefreshCycle(a, now)).enqueued, 1);
    const rates = await a.distributionOutboxEvent.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    assert.deepEqual(rates.changedFields, ["rate"]);
    await a.$executeRaw`UPDATE "Reservation" SET status='CANCELLED' WHERE id='r-a'`;
    assert.equal((await runRateRefreshCycle(b, now)).enqueued, 1);
    await a.$executeRaw`UPDATE "Reservation" SET status='ACTIVE' WHERE id='r-a'`;
    assert.equal((await runRateRefreshCycle(a, now)).enqueued, 1);

    const tomorrow = new Date("2026-10-13T21:00:00Z");
    assert.equal((await runRateRefreshCycle(b, tomorrow)).enqueued, 2);
    const tail = await a.distributionOutboxEvent.findFirstOrThrow({ where: { messageKind: "AVAILABILITY" }, orderBy: { createdAt: "desc" } });
    assert.equal((tail.dateToExclusive!.getTime() - tail.dateFrom!.getTime()) / 86400000, 1);

    const count = await a.distributionOutboxEvent.count();
    await a.$executeRawUnsafe(`ALTER TABLE "DistributionOutboxEvent" ADD CONSTRAINT reject_test_rates CHECK ("messageKind" <> 'RATES_RESTRICTIONS') NOT VALID`);
    assert.equal((await runRateRefreshCycle(a, new Date("2026-10-14T21:00:00Z"))).failed, 1);
    assert.equal(await a.distributionOutboxEvent.count(), count);
    await a.$executeRawUnsafe(`ALTER TABLE "DistributionOutboxEvent" DROP CONSTRAINT reject_test_rates`);
    assert.equal((await runRateRefreshCycle(b, new Date("2026-10-14T21:00:00Z"))).enqueued, 2);
  } finally {
    await a.$disconnect(); await b.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
  }
});
