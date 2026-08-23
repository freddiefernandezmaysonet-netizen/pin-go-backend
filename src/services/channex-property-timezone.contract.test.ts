import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
}

test("property creation requires an explicit validated IANA timezone", () => {
  const source = readSource("../routes/properties.create.route.ts");

  assert.match(source, /requireIanaTimezone\(req\.body\?\.timezone\)/);
  assert.doesNotMatch(
    source,
    /req\.body\?\.timezone[\s\S]{0,160}America\/Puerto_Rico/
  );
});

test("Channex provisioning sends the property's validated timezone without a Puerto Rico fallback", () => {
  const source = readSource("./channex-provisioning.service.ts");

  assert.match(source, /requireIanaTimezone\(property\.timezone/);
  assert.match(source, /timezone:\s*propertyTimezone/);
  assert.doesNotMatch(
    source,
    /property\.timezone\s*\?\?\s*["']America\/Puerto_Rico["']/
  );
});

test("ARI Availability resolves timezone from the property record", () => {
  const source = readSource("../pms/outbound/channex-ari-snapshot.service.ts");

  assert.match(source, /property\.timezone/);
  assert.match(source, /propertyTimezone/);
  assert.doesNotMatch(
    source,
    /property\.timezone\s*\?\?\s*["']America\/Puerto_Rico["']/
  );
});

test("Channex Full Sync requires the property's validated timezone without a Puerto Rico fallback", () => {
  const source = readSource("../routes/dashboard.channex-full-sync.route.ts");

  assert.match(source, /requireIanaTimezone\(propertyTimezone\)/);
  assert.match(
    source,
    /resolveFullSyncTodayDateKey\(\s*requestedAt,\s*property\.timezone\s*\)/
  );
  assert.doesNotMatch(
    source,
    /property\.timezone\s*\?\?\s*["']America\/Puerto_Rico["']/
  );
});
