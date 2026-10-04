import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings.js";
import { getPropertyStayTimeSettings, updatePropertyStayTimeSettings } from "./property-stay-time-settings.service.js";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("disposable PostgreSQL migration, persistence and revision concurrency", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  let organizationId: string | null = null;
  let propertyId: string | null = null;
  t.after(async () => {
    try {
      if (propertyId) await db.property.delete({ where: { id: propertyId } });
      if (organizationId) await db.organization.delete({ where: { id: organizationId } });
    } finally { await db.$disconnect(); }
  });
  await t.test("ordered stay-time migrations preserve synthetic payment and cleaning history", async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE SCHEMA stay_time_migration_test');
      await tx.$executeRawUnsafe('SET LOCAL search_path TO stay_time_migration_test');
      // Minimal pre-change tables exercise the actual three migration files.
      // This is not a rehearsal of the complete production migration history.
      await tx.$executeRawUnsafe('CREATE TABLE "Property" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL)');
      await tx.$executeRawUnsafe('INSERT INTO "Property" ("id", "name") VALUES (\'existing\', \'Preserved property\')');
      await tx.$executeRawUnsafe(`CREATE TABLE "ReservationModification" (
        "id" TEXT PRIMARY KEY, "requestSource" TEXT NOT NULL, "status" TEXT NOT NULL,
        "amountDifference" NUMERIC(12,2) NOT NULL, "stripePaymentIntentId" TEXT,
        "receipt" JSONB NOT NULL)`);
      await tx.$executeRawUnsafe(`INSERT INTO "ReservationModification" VALUES
        ('paid', 'PIN_AI_GUEST_SERVICES', 'APPLIED', 11, 'pi_synthetic', '{"kind":"payment","amountMinor":1100}'),
        ('pending', 'PIN_AI_GUEST_SERVICES', 'PAYMENT_PROCESSING', 7, NULL, '{"kind":"pending"}'),
        ('ordinary', 'GUEST', 'APPLIED', 5, NULL, '{"kind":"ordinary"}')`);
      await tx.$executeRawUnsafe(`CREATE TABLE "CleaningWork" (
        "id" TEXT PRIMARY KEY, "reservationId" TEXT NOT NULL, "staffMemberId" TEXT NOT NULL,
        "confirmationId" TEXT NOT NULL, "receipt" JSONB NOT NULL)`);
      await tx.$executeRawUnsafe(`CREATE UNIQUE INDEX "CleaningWork_reservationId_staffMemberId_key"
        ON "CleaningWork" ("reservationId", "staffMemberId")`);
      await tx.$executeRawUnsafe(`INSERT INTO "CleaningWork" VALUES
        ('work-original', 'reservation', 'cleaner', 'confirmation-original', '{"consent":true,"completed":true,"notice":"synthetic"}')`);
      // Keep the pre-DDL projection stable: Prisma caches prepared statements,
      // and SELECT * changes its result type when the migration adds columns.
      const paymentsBefore = await tx.$queryRawUnsafe<any[]>(`SELECT "id", "requestSource", "status",
        "amountDifference", "stripePaymentIntentId", "receipt" FROM "ReservationModification" ORDER BY "id"`);
      const cleaningBefore = await tx.$queryRawUnsafe<any[]>('SELECT * FROM "CleaningWork" ORDER BY "id"');
      for (const name of [
        "20261001110000_property_stay_time_settings_v1",
        "20261001183000_cleaning_work_confirmation_history",
        "20261003010000_stay_time_recovery",
      ]) {
        const sql = readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8");
        for (const statement of sql.split(";").filter(value => value.trim())) await tx.$executeRawUnsafe(statement);
      }
      const rows = await tx.$queryRawUnsafe<any[]>('SELECT * FROM "Property"');
      assert.deepEqual(rows, [{ id: "existing", name: "Preserved property", stayTimeSettings: null, stayTimeSettingsRevision: 0 }]);
      const recoveryDefaults = { stayTimeReconciledAt: null, stayTimeRecoveryNextAt: null,
        stayTimeRecoveryLeaseToken: null, stayTimeRecoveryLeaseUntil: null, stayTimeRecoveryAttempts: 0 };
      assert.deepEqual(await tx.$queryRawUnsafe<any[]>('SELECT * FROM "ReservationModification" ORDER BY "id"'),
        paymentsBefore.map(row => ({ ...row, ...recoveryDefaults })));
      assert.deepEqual(await tx.$queryRawUnsafe<any[]>('SELECT * FROM "CleaningWork" ORDER BY "id"'), cleaningBefore);

      // Existing writers can still omit every newly added field.
      await tx.$executeRawUnsafe(`INSERT INTO "Property" ("id", "name") VALUES ('old-writer', 'Compatible')`);
      await tx.$executeRawUnsafe(`INSERT INTO "ReservationModification"
        ("id", "requestSource", "status", "amountDifference", "receipt")
        VALUES ('old-writer', 'GUEST', 'AWAITING_PAYMENT', 3, '{}')`);
      assert.deepEqual(await tx.$queryRawUnsafe<any[]>(`SELECT "stayTimeSettings", "stayTimeSettingsRevision"
        FROM "Property" WHERE "id" = 'old-writer'`), [{ stayTimeSettings: null, stayTimeSettingsRevision: 0 }]);
      const inserted = await tx.$queryRawUnsafe<any[]>(`SELECT * FROM "ReservationModification" WHERE "id" = 'old-writer'`);
      for (const [key, value] of Object.entries(recoveryDefaults)) assert.equal(inserted[0][key], value);

      await tx.$executeRawUnsafe('SAVEPOINT invalid_revision');
      await assert.rejects(() => tx.$executeRawUnsafe(`UPDATE "Property" SET "stayTimeSettingsRevision" = -1 WHERE "id" = 'existing'`),
        /Property_stayTimeSettingsRevision_nonnegative/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_revision');
      await tx.$executeRawUnsafe(`INSERT INTO "CleaningWork" VALUES
        ('work-renewed', 'reservation', 'cleaner', 'confirmation-renewed', '{"consent":false}')`);
      await tx.$executeRawUnsafe('SAVEPOINT duplicate_confirmation');
      await assert.rejects(() => tx.$executeRawUnsafe(`INSERT INTO "CleaningWork" VALUES
        ('work-duplicate', 'reservation', 'cleaner', 'confirmation-renewed', '{}')`), /CleaningWork_confirmation_scope_key/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT duplicate_confirmation');
      assert.deepEqual(await tx.$queryRawUnsafe<any[]>(`SELECT * FROM "CleaningWork" WHERE "id" = 'work-original'`), cleaningBefore);
      const indexes = await tx.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(`SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'stay_time_migration_test' AND indexname = 'ReservationModification_stay_time_recovery_idx'`);
      assert.equal(indexes.length, 1);
      assert.match(indexes[0].indexdef, /\("requestSource", status, "stayTimeRecoveryNextAt"\)/);
      await tx.$executeRawUnsafe('DROP TABLE "CleaningWork"');
      await tx.$executeRawUnsafe('DROP TABLE "ReservationModification"');
      await tx.$executeRawUnsafe('DROP TABLE "Property"');
      await tx.$executeRawUnsafe('DROP SCHEMA stay_time_migration_test');
    }, { timeout: 30_000 });
  });
  const org = await db.organization.create({ data: { name: "Synthetic stay time test" } });
  organizationId = org.id;
  const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic property",
    timezone: "America/Puerto_Rico", checkInTime: "15:00", checkOutTime: "11:00" } });
  propertyId = property.id;
  await t.test("default read has no write, concurrent compare-and-swap has one winner", async () => {
    const initial = await getPropertyStayTimeSettings(db, org.id, property.id);
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.settings, defaultStayTimeSettings());
    const body = { expectedRevision: 0, settings: defaultStayTimeSettings() };
    const results = await Promise.allSettled([
      updatePropertyStayTimeSettings(db, org.id, property.id, body),
      updatePropertyStayTimeSettings(db, org.id, property.id, body),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "STAY_TIME_SETTINGS_CONFLICT");
    assert.equal((await getPropertyStayTimeSettings(db, org.id, property.id)).revision, 1);
    await assert.rejects(() => updatePropertyStayTimeSettings(db, "other-org", property.id, body), /STAY_TIME_PROPERTY_NOT_FOUND/);
    const final = await db.property.findUniqueOrThrow({ where: { id: property.id } });
    assert.equal(final.name, "Synthetic property");
    assert.equal(final.checkInTime, "15:00");
    assert.equal(final.stayTimeSettingsRevision, 1);
  });
});
