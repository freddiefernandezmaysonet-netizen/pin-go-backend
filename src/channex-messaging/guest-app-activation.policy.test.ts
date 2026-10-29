import test from "node:test";
import assert from "node:assert/strict";
import { guestAppActivationUrl, buildAirbnbAccessText } from "./airbnb-access.policy.js";
const now = new Date("2026-10-25T18:00:00Z");
const token = "synthetic_private_stay_token_123456";
const stay = { guestToken: token, guestTokenExpiresAt: new Date("2026-10-28T18:00:00Z") };

test("activation retains the existing token and uses the configured public API origin", () => {
  assert.equal(guestAppActivationUrl(stay, now, { PUBLIC_API_BASE_URL: "https://api.pin-ngo.com/" }), `https://api.pin-ngo.com/guest/app/${token}`);
  assert.equal(stay.guestToken, token);
});
test("expired, missing and revoked stay links are not offered", () => {
  for (const changed of [{ guestToken: null }, { guestToken: "invalid/token" }, { guestTokenExpiresAt: now }, { guestStayLink: { revokedAt: now } }]) {
    assert.equal(guestAppActivationUrl({ ...stay, ...changed }, now, {}), null);
  }
});
test("misconfigured public origins never produce insecure or credential-bearing links", () => {
  for (const base of ["http://localhost:3000", "https://user:password@api.pin-ngo.com", "https://api.pin-ngo.com/private", "https://api.pin-ngo.com?secret=test", "invalid"]) {
    assert.equal(guestAppActivationUrl(stay, now, { PUBLIC_API_BASE_URL: base }), null);
  }
});
for (const language of ["en", "es"]) test(language + " activation explains linking and reopening after installation without a passcode", () => {
  const guestAppUrl = guestAppActivationUrl(stay, now, {})!;
  const text = buildAirbnbAccessText({ type: "GUEST_APP_ACTIVATION", propertyName: "Test property", language,
    timezone: "America/Puerto_Rico", checkIn: now, checkOut: stay.guestTokenExpiresAt, guestAppUrl });
  assert.ok(text.includes(guestAppUrl));
  assert.match(text, language === "es" ? /vuelve a abrir/ : /same link again/);
  assert.match(text, /opcional|optional/);
  assert.match(text, /navegador|browser/);
  assert.doesNotMatch(text, /Tu código|Your access code|987654/);
});
