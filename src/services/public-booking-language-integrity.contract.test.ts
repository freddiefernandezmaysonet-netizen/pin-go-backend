import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readProjectFile(relativePath: string) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("property stores an independent Spanish public description", async () => {
  const [schema, migration] = await Promise.all([
    readProjectFile("prisma/schema.prisma"),
    readProjectFile(
      "prisma/migrations/20260817174418_add_spanish_public_description/migration.sql"
    ),
  ]);

  assert.match(schema, /publicDescriptionEs\s+String\?/);
  assert.match(migration, /ADD COLUMN "publicDescriptionEs" TEXT/);
});

test("dashboard and public booking routes expose the Spanish description", async () => {
  const [dashboardRoute, publicRoute] = await Promise.all([
    readProjectFile("src/routes/dashboard.properties.route.ts"),
    readProjectFile("src/routes/public-booking.routes.ts"),
  ]);

  assert.match(
    dashboardRoute,
    /if \(publicDescriptionEs !== undefined\)[\s\S]*data\.publicDescriptionEs/
  );
  assert.ok(
    (dashboardRoute.match(/publicDescriptionEs:\s*true/g) ?? []).length >= 2
  );
  assert.ok(
    (publicRoute.match(/publicDescriptionEs:\s*true/g) ?? []).length >= 2
  );
});
