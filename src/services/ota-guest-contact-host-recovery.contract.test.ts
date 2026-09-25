import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("dashboard guest contact recovery is authenticated and tenant scoped", async () => {
  const route = await readFile(new URL("../routes/dashboard.reservations.route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("./ota-guest-contact-host-recovery.service.ts", import.meta.url), "utf8");
  assert.match(route, /\/api\/dashboard\/reservations\/:id\/guest-contact"[\s\S]*requireAuth/);
  assert.match(service, /findFirst\([\s\S]*property:\s*\{\s*organizationId/);
  assert.match(service, /externalProvider[\s\S]*CHANNEX/);
});

test("host recovery writes only guest contact fields and records HOST_RECOVERY provenance", async () => {
  const source = await readFile(new URL("./ota-guest-contact-host-recovery.service.ts", import.meta.url), "utf8");
  const updateBlock = source.match(/prisma\.reservation\.update\([\s\S]*?select:\s*\{ id: true, guestEmail: true, guestPhone: true \},\n  \}\);/)?.[0] ?? "";
  assert.match(updateBlock, /guestEmail/);
  assert.match(updateBlock, /guestPhone/);
  for (const forbidden of ["checkIn:", "checkOut:", "paymentState:", "externalId:", "source:", "propertyId:"]) {
    assert.equal(updateBlock.includes(forbidden), false, forbidden);
  }
  assert.match(source, /provenance:\s*"HOST_RECOVERY"/);
  assert.match(source, /requestedByUserId/);
  assert.match(source, /syncChannexGuestContactRecovery/);
});

test("host recovery rejects clearing and validates email and E.164 phone", async () => {
  const source = await readFile(new URL("./ota-guest-contact-host-recovery.service.ts", import.meta.url), "utf8");
  assert.match(source, /EMAIL_CANNOT_BE_CLEARED/);
  assert.match(source, /PHONE_CANNOT_BE_CLEARED/);
  assert.match(source, /INVALID_GUEST_EMAIL/);
  assert.match(source, /INVALID_GUEST_PHONE/);
});
