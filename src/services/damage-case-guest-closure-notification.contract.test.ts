import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const service = readFileSync(
  new URL("./damage-case-guest-closure-notification.service.ts", import.meta.url),
  "utf8"
);
const route = readFileSync(
  new URL("../routes/dashboard.damage-cases.routes.ts", import.meta.url),
  "utf8"
);
const mailer = readFileSync(
  new URL("../lib/mailer.ts", import.meta.url),
  "utf8"
);
const emailDelivery = readFileSync(
  new URL("./email-delivery.service.ts", import.meta.url),
  "utf8"
);
const retryWorker = readFileSync(
  new URL("../workers/message.retry.worker.ts", import.meta.url),
  "utf8"
);

const mailerStart = mailer.indexOf(
  "export async function sendPropertyProtectionGuestClosureNotice"
);
const mailerEnd = mailer.indexOf(
  "export async function sendPropertyProtectionHostGuestResponseNotice",
  mailerStart
);
const closureMailer = mailer.slice(mailerStart, mailerEnd);

test("no-charge closure is persisted before guest notification", () => {
  const closureUpdate = route.indexOf(
    "status: DamageCaseStatus.CLOSED_NO_CHARGE"
  );
  const notification = route.indexOf(
    "notifyGuestOfClosureSafely",
    closureUpdate
  );
  assert.ok(closureUpdate >= 0);
  assert.ok(notification > closureUpdate);
  assert.match(route, /DAMAGE_CASE_GUEST_CLOSURE_NOTICE_UNEXPECTED_ERROR/);
  assert.match(route, /guestClosureNotification/);
});

test("only a previously guest-visible closed case sends a closure notice", () => {
  assert.match(service, /DamageCaseStatus\.CLOSED_NO_CHARGE/);
  assert.match(service, /guestNotifiedAt: true/);
  assert.match(service, /if \(!damageCase\.guestNotifiedAt\)/);
  assert.match(
    service,
    /DAMAGE_CASE_GUEST_CLOSURE_NOTICE_NOT_PREVIOUSLY_VISIBLE/
  );
});

test("closure notice is brief, localized, and explicitly non-charging", () => {
  assert.match(closureMailer, /Manage reservation/);
  assert.match(closureMailer, /Administrar reservación/);
  assert.match(closureMailer, /No charge has been made/);
  assert.match(closureMailer, /No se ha realizado ningún cargo/);
  assert.match(closureMailer, /preferredLanguage/);
  assert.doesNotMatch(closureMailer, /requestedAmount/);
  assert.doesNotMatch(closureMailer, /approvedAmount/);
  assert.doesNotMatch(closureMailer, /maxDamageLiabilityAmount/);
  assert.doesNotMatch(closureMailer, /closedReason/);
  assert.doesNotMatch(closureMailer, /evidence/);
  assert.doesNotMatch(closureMailer, /guestResponseNote/);
});

test("closure delivery is idempotent, logged, and retryable", () => {
  assert.match(
    service,
    /PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE/
  );
  assert.match(service, /messageLog\.findFirst/);
  assert.match(service, /existing\?\.status === "SENT"/);
  assert.match(service, /existing\?\.status === "FAILED"/);
  assert.match(service, /sendLoggedEmail/);
  assert.match(
    service,
    /property-protection-no-charge-closure-\$\{damageCase\.id\}/
  );
  assert.match(
    emailDelivery,
    /PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE/
  );
  assert.match(
    retryWorker,
    /processPropertyProtectionGuestClosureRetries/
  );
  assert.match(
    retryWorker,
    /await processPropertyProtectionGuestClosureRetries\(\)/
  );
});

test("automatic closure retry preserves the closed case state", () => {
  const retryStart = retryWorker.indexOf(
    "async function processPropertyProtectionGuestClosureRetries"
  );
  const retryEnd = retryWorker.indexOf(
    "function parsePropertyProtectionHostResponseRetryPayload",
    retryStart
  );
  const retryBlock = retryWorker.slice(retryStart, retryEnd);
  assert.match(retryBlock, /status !== "CLOSED_NO_CHARGE"/);
  assert.match(retryBlock, /prisma\.messageLog\.update/);
  assert.doesNotMatch(retryBlock, /damageCase\.update/);
  assert.doesNotMatch(retryBlock, /CHARGE_BLOCKED/);
});

test("closure notice preserves Manage Reservation access", () => {
  assert.match(service, /guestTokenExpiresAt: true/);
  assert.match(service, /30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(service, /guestTokenExpiresAt: minimumPortalExpiry/);
  assert.match(
    retryWorker,
    /processPropertyProtectionGuestClosureRetries[\s\S]*guestTokenExpiresAt: minimumPortalExpiry/
  );
});

test("closure notification remains outside the financial engine", () => {
  const combined = service + route + retryWorker;
  assert.doesNotMatch(combined, /paymentIntents\./);
  assert.doesNotMatch(combined, /charges\./);
  assert.doesNotMatch(combined, /capture_method/);
  assert.doesNotMatch(combined, /refunds\./);
});
