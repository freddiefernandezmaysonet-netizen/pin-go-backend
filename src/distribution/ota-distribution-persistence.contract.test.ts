import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const persistenceSource = readFileSync(
  new URL("./ota-distribution-persistence.service.ts", import.meta.url),
  "utf8"
);
const sessionSource = readFileSync(
  new URL("./ota-connection-session.service.ts", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260905190000_add_ota_distribution_persistence/migration.sql",
    import.meta.url
  ),
  "utf8"
);

test("new distribution services cannot call Channex, OTAs, or Direct Booking", () => {
  const source = `${persistenceSource}\n${sessionSource}`;
  for (const forbidden of [
    "axios",
    "fetch(",
    "channex-provisioning",
    "channex.adapter",
    "direct-booking",
    "directBooking",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden boundary: ${forbidden}`);
  }
  assert.match(sessionSource, /OneTimeConnectionTokenIssuer/);
});

test("migration is additive and includes every commercial persistence table", () => {
  assert.match(migration, /^-- OTA Distribution commercial persistence/m);
  for (const table of [
    "DistributionGroup",
    "DistributionProperty",
    "OtaChannelConnection",
    "OtaConnectionSession",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.equal(/^\s*(?:DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/im.test(migration), false);
  assert.match(migration, /tokenFingerprint.*\^\[0-9a-f\]\{64\}\$/s);
  assert.equal(migration.includes('"token" TEXT'), false);
});
