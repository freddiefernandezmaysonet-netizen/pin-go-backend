import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function read(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("Channex missing-contact ingest invokes idempotent host notification after recovery projection", async () => {
  const ingest = await read("./ingest.service.ts");
  const notification = await read("./ota-guest-contact-recovery-host-notification.service.ts");
  assert.match(ingest, /syncChannexGuestContactRecovery[\s\S]*notifyHostGuestContactRecoveryRequired/);
  assert.match(notification, /workflowState[\s\S]*ACTION_REQUIRED/);
  assert.match(notification, /communicationType:\s*TYPE/);
  assert.match(notification, /status:\s*"SENT"/);
  assert.match(notification, /CHANNEX_GUEST_CONTACT_RECOVERY_REQUIRED/);
  assert.match(notification, /guest-contact-recovery:\$\{reservation\.id\}:\$\{to\}/);
});

test("host recovery materializes canonical Guest Journey access communications instead of sending directly", async () => {
  const recovery = await read("./ota-guest-contact-host-recovery.service.ts");
  assert.match(recovery, /materializeGuestAccessCommunicationOutbox/);
  assert.match(recovery, /AccessGrantType\.GUEST/);
  assert.match(recovery, /ACCESS_COMMUNICATIONS_OUTBOX_RELEASE_EVIDENCE_MISSING/);
  assert.match(recovery, /ACCESS_COMMUNICATIONS_OUTBOX_CANONICAL_GRANT_MISSING_OR_AMBIGUOUS/);
  assert.doesNotMatch(recovery, /sendGuestAccessPasscodeEmail|sendGuestPasscodeSms|sendLoggedEmail/);
});

test("host recovery notification links only to authenticated Reservation Detail", async () => {
  const notification = await read("./ota-guest-contact-recovery-host-notification.service.ts");
  assert.match(notification, /\/reservations\/\$\{encodeURIComponent\(reservation\.id\)\}/);
  assert.doesNotMatch(notification, /booking\/manage|guestToken/);
});

test("contact completeness remains separate from channel eligibility", async () => {
  const bridge = await read("./guest-journey-access-communications-bridge.policy.ts");
  assert.match(bridge, /if \(email\)/);
  assert.match(bridge, /if \(phone && hasGuestSmsConsent\(input\.externalRaw\)\)/);
});
