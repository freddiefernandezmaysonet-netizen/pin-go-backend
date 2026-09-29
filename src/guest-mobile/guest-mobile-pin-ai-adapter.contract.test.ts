import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const route = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");
const service = await fs.readFile(new URL("./guest-mobile-session.service.ts", import.meta.url), "utf8");

test("mobile Pin AI endpoints require GuestDeviceSession and stay scope", () => {
  for (const marker of [
    '"/api/guest-mobile/stays/:reservationNumber/pin-ai/history"',
    '"/api/guest-mobile/stays/:reservationNumber/pin-ai/messages"',
  ]) {
    const start = route.indexOf(marker);
    assert.ok(start >= 0);
    const block = route.slice(start, start + 4500);
    assert.match(block, /resolveGuestMobileSession/);
    assert.match(block, /resolveGuestMobilePinAIScope/);
    assert.match(block, /guestPersonId: session\.guestPersonId/);
  }
});

test("private guestToken remains backend-only adapter material", () => {
  const start = service.indexOf("export async function resolveGuestMobilePinAIScope");
  const block = service.slice(start);
  assert.match(block, /guestToken: true/);
  assert.match(route, /gateway\.reply\(\{ guestToken: scope\.guestToken/);
  assert.doesNotMatch(route, /guestToken:\s*scope\.guestToken[^\n]*res\./);
  assert.doesNotMatch(route, /json\([^\n]*guestToken/);
});

test("adapter reuses canonical Pin AI guest runtime and history", () => {
  assert.match(route, /new GuestPinAIGateway/);
  assert.match(route, /createGuestPinAIRuntimeRunner/);
  assert.match(route, /readGuestHistory/);
});

test("V1 does not expose mobile action confirmation endpoints", () => {
  assert.doesNotMatch(route, /guest-mobile[^\n]*action-proposals[^\n]*confirm/);
  assert.doesNotMatch(route, /confirmAndExecute/);
});
