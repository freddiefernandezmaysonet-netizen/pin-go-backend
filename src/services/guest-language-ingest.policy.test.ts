import assert from "node:assert/strict";
import test from "node:test";
import { resolveIngestGuestLanguage } from "./guest-language-ingest.policy";
import { readFileSync } from "node:fs";
const ota = { externalProvider: "CHANNEX", externalId: "booking-1" };
const payload = (language: unknown) => ({ ...ota, externalRaw: { booking: { customer: { language } } } });
for (const [value, expected] of [["en", "en"], ["es", "es"], [" ES_pr ", "es"], ["en-US", "en"]]) {
  test(`maps received customer.language ${value}`, () => {
    assert.equal(resolveIngestGuestLanguage(payload(value)), expected);
  });
}
test("absent, unsupported and malformed OTA language preserve Spanish on revision", () => {
  for (const value of [undefined, null, "", " ", "fr", "spanish", 1, [], {}, "es!"]) {
    const language = resolveIngestGuestLanguage(payload(value));
    const patch = language === undefined ? {} : { preferredLanguage: language };
    assert.deepEqual({ preferredLanguage: "es", ...patch }, { preferredLanguage: "es" });
  }
  assert.equal(resolveIngestGuestLanguage({ ...ota, externalRaw: null }), undefined);
});
test("explicit OTA English updates Spanish and does not mutate raw payload", () => {
  const input = payload("en"); const original = JSON.stringify(input);
  assert.equal(resolveIngestGuestLanguage(input), "en");
  assert.equal(JSON.stringify(input), original);
});
test("Direct Booking and other providers keep existing normalization", () => {
  for (const externalProvider of ["PIN_GO_DIRECT", "LODGIFY", "PIN_GO_MANUAL", undefined]) {
    assert.equal(resolveIngestGuestLanguage({ ...payload("es"), externalProvider }), "en");
    assert.equal(resolveIngestGuestLanguage({ externalProvider, preferredLanguage: "es" }), "es");
    assert.equal(resolveIngestGuestLanguage({ externalProvider, preferredLanguage: "es-PR" }), "en");
  }
  assert.equal(resolveIngestGuestLanguage({ ...payload("es"), externalId: " " }), "en");
});
test("ingestion reads original booking payload and omits unknown language in all five persistence paths", () => {
  const ingest = readFileSync(new URL("./ingest.service.ts", import.meta.url), "utf8");
  const lifecycle = readFileSync(new URL("../pms/ingest/channex-booking-lifecycle.service.ts", import.meta.url), "utf8");
  assert.match(lifecycle, /booking: args\.revision\.reservation\.raw/);
  assert.match(ingest, /const preferredLanguage = resolveIngestGuestLanguage\(p\)/);
  assert.equal((ingest.match(/input\.preferredLanguage !== undefined/g) ?? []).length, 5);
  assert.match(readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8"), /preferredLanguage\s+String\s+@default\("en"\)/);
});
