import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";

// PostgreSQL WASM, in memory only: no DATABASE_URL, sockets or provider calls.
test("provisioning migration preserves organizations and enforces durable attempt uniqueness", async () => {
  assert.ok(process.env.PINGO_PGLITE_MODULE, "Explicit local PGlite module required");
  const { PGlite } = await import(pathToFileURL(process.env.PINGO_PGLITE_MODULE).href);
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY, "stripeConnectAccountId" TEXT); INSERT INTO "Organization" VALUES (\'org-a\', \'acct-existing\'), (\'org-b\', NULL);');
    await db.exec(readFileSync("prisma/migrations/20260923180000_stripe_connect_provisioning/migration.sql", "utf8"));
    assert.equal((await db.query('SELECT "stripeConnectAccountId" FROM "Organization" WHERE id=\'org-a\'')).rows[0].stripeConnectAccountId, "acct-existing");
    const insert = 'INSERT INTO "StripeConnectProvisioning" ("organizationId", "idempotencyKey", request, "updatedAt") VALUES ($1, $2, \'{}\', NOW())';
    await db.query(insert, ["org-a", "key-a"]);
    await assert.rejects(db.query(insert, ["org-a", "key-other"]), /duplicate key/);
    await assert.rejects(db.query(insert, ["org-b", "key-a"]), /duplicate key/);
    await assert.rejects(db.query(insert, ["org-missing", "key-missing"]), /foreign key/);
    await db.query(insert, ["org-b", "key-b"]);
    await db.exec('UPDATE "StripeConnectProvisioning" SET "accountId"=\'acct-a\', state=\'ACCOUNT_CREATED\' WHERE "organizationId"=\'org-a\'');
    await assert.rejects(db.exec('UPDATE "StripeConnectProvisioning" SET "accountId"=\'acct-a\' WHERE "organizationId"=\'org-b\''), /duplicate key/);
    await assert.rejects(db.exec('UPDATE "StripeConnectProvisioning" SET state=\'INVALID\''), /check constraint/);
    await assert.rejects(db.exec('DELETE FROM "Organization" WHERE id=\'org-a\''), /foreign key/);
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('UPDATE "Organization" SET "stripeConnectAccountId"=\'acct-new\' WHERE id=\'org-b\'');
      throw new Error("simulated failure before attachment commit");
    }));
    assert.equal((await db.query('SELECT "stripeConnectAccountId" FROM "Organization" WHERE id=\'org-b\'')).rows[0].stripeConnectAccountId, null);
  } finally { await db.close(); }
});
