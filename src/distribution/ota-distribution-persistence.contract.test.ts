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
const orchestrationSource = readFileSync(
  new URL("./ota-connection-orchestrator.service.ts", import.meta.url),
  "utf8"
);
const adapterSource = readFileSync(
  new URL("./channex-white-label.adapter.ts", import.meta.url),
  "utf8"
);
const compositionSource = readFileSync(
  new URL("./ota-connection-center.composition.ts", import.meta.url),
  "utf8"
);
const repositorySource = readFileSync(
  new URL("./ota-provisioning.repository.ts", import.meta.url),
  "utf8"
);
const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260905190000_add_ota_distribution_persistence/migration.sql",
    import.meta.url
  ),
  "utf8"
);

test("new distribution services cannot call Channex, OTAs, or Direct Booking", () => {
  const source = `${persistenceSource}\n${sessionSource}\n${orchestrationSource}`;
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
  assert.doesNotMatch(adapterSource, /from\s+["']axios|fetch\s*\(|process\.env|console\./);
  assert.match(adapterSource, /WhiteLabelHttpTransport/);
  assert.doesNotMatch(compositionSource, /from\s+["']axios|fetch\s*\(/);
  assert.doesNotMatch(repositorySource, /from\s+["']axios|fetch\s*\(/);
  assert.match(serverSource, /buildOtaConnectionCenterComposition\(\{[\s\S]*?trustedMutationOrigins:\s*allowedOrigins,[\s\S]*?\}\)/);
  assert.doesNotMatch(
    serverSource,
    /buildOtaConnectionCenterComposition\(\{[\s\S]*?adapter:/
  );
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
