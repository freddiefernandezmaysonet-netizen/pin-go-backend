import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("StaffMember preferred language is additive and defaults to English", () => {
  const schema=fs.readFileSync(new URL("../../prisma/schema.prisma",import.meta.url),"utf8");
  const migration=fs.readFileSync(new URL("../../prisma/migrations/20260930210000_staff_preferred_language_v1/migration.sql",import.meta.url),"utf8");
  assert.match(schema,/model StaffMember[\s\S]*preferredLanguage\s+String\s+@default\("en"\)/);
  assert.match(migration,/ADD COLUMN "preferredLanguage" VARCHAR\(5\) NOT NULL DEFAULT 'en'/);
  assert.doesNotMatch(migration,/DROP|DELETE|TRUNCATE/i);
});

test("Staff API accepts preferred language on create and update", () => {
  const source=fs.readFileSync(new URL("../routes/staff.routes.ts",import.meta.url),"utf8");
  assert.match(source,/preferredLanguage:\s*preferredLanguage === undefined \? "en" : parseStaffLanguage/);
  assert.match(source,/preferredLanguage !== undefined[\s\S]*parseStaffLanguage\(preferredLanguage\)/);
});

test("cleaner mobile lifecycle derives language from StaffMember", () => {
  const source=fs.readFileSync(new URL("../routes/cleaning-confirm.routes.ts",import.meta.url),"utf8");
  assert.match(source,/resolveStaffLanguage\(staffMember\??\.preferredLanguage\)/);
  assert.match(source,/Limpieza completada/);
  assert.match(source,/Confirmar disponibilidad/);
  assert.match(source,/Comence la limpieza/);
  assert.match(source,/Termine la limpieza/);
  assert.match(source,/html lang="\$\{language\}"/);
});
