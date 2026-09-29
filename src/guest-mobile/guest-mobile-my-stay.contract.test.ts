import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const route = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");
const service = await fs.readFile(new URL("./guest-mobile-session.service.ts", import.meta.url), "utf8");

test("My Stay requires a GuestDeviceSession bearer before stay lookup", () => {
  const start = route.indexOf('"/api/guest-mobile/stays/:reservationNumber"');
  assert.ok(start >= 0);
  const block = route.slice(start);
  assert.match(block, /resolveGuestMobileSession\(prisma, match\[1\]\)/);
  assert.match(block, /guestPersonId: session\.guestPersonId/);
  assert.match(block, /reservationNumber:/);
});

test("My Stay is scoped through GuestStayLink and guestPersonId", () => {
  const start = service.indexOf("export async function readGuestMobileStay");
  const block = service.slice(start);
  assert.match(block, /guestStayLink\.findFirst/);
  assert.match(block, /guestPersonId: input\.guestPersonId/);
  assert.match(block, /revokedAt: null/);
});

test("My Stay projection contains no physical access credentials", () => {
  const start = service.indexOf("export async function readGuestMobileStay");
  const block = service.slice(start);
  assert.doesNotMatch(block, /passcode|lockId|accessGrantId|nfc|ttlock/i);
  assert.match(block, /guestAccessReleaseStatus: true/);
});
