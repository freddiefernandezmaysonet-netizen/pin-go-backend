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
  await t.test("additive migration preserves existing rows and initializes disabled defaults", async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE SCHEMA stay_time_migration_test');
      await tx.$executeRawUnsafe('SET LOCAL search_path TO stay_time_migration_test');
      await tx.$executeRawUnsafe('CREATE TABLE "Property" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL)');
      await tx.$executeRawUnsafe('INSERT INTO "Property" ("id", "name") VALUES (\'existing\', \'Preserved property\')');
      const sql = readFileSync(new URL("../../prisma/migrations/20261001110000_property_stay_time_settings_v1/migration.sql", import.meta.url), "utf8");
      for (const statement of sql.split(";").filter(value => value.trim())) await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRawUnsafe<any[]>('SELECT * FROM "Property"');
      assert.deepEqual(rows, [{ id: "existing", name: "Preserved property", stayTimeSettings: null, stayTimeSettingsRevision: 0 }]);
      await tx.$executeRawUnsafe('DROP TABLE "Property"');
      await tx.$executeRawUnsafe('DROP SCHEMA stay_time_migration_test');
    });
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
