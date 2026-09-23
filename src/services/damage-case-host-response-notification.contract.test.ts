import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const notificationService = readFileSync(
  new URL("./damage-case-host-response-notification.service.ts", import.meta.url),
  "utf8"
);
const responseService = readFileSync(
  new URL("./damage-case-guest-response.service.ts", import.meta.url),
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

test("only final guest responses notify the host", () => {
  assert.match(
    notificationService,
    /DamageCaseGuestResponse\.ACCEPTED/
  );
  assert.match(
    notificationService,
    /DamageCaseGuestResponse\.DISPUTED/
  );
  assert.doesNotMatch(
    notificationService,
    /DamageCaseGuestResponse\.ACKNOWLEDGED/
  );
  assert.match(
    responseService,
    /notifyHostOfGuestDamageCaseResponse/
  );
  assert.match(responseService, /notifyHostSafely/);
});

test("host recipients remain organization-scoped active administrators", () => {
  assert.match(notificationService, /organizationId/);
  assert.match(notificationService, /isActive: true/);
  assert.match(
    notificationService,
    /role: DashboardUserRole\.ORG_ADMIN/
  );
  assert.match(notificationService, /seen\.has\(email\)/);
});

test("host response notice is idempotent per recipient and logged", () => {
  assert.match(
    notificationService,
    /PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE/
  );
  assert.match(notificationService, /messageLog\.findFirst/);
  assert.match(notificationService, /existing\?\.status === "SENT"/);
  assert.match(notificationService, /existing\?\.status === "FAILED"/);
  assert.match(notificationService, /sendLoggedEmail/);
  assert.match(
    notificationService,
    /property-protection-host-response-\$\{damageCase\.id\}-\$\{guestResponse\}-\$\{recipient\.email\}/
  );
  assert.match(
    emailDelivery,
    /PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE/
  );
});

test("email is brief, bilingual, and keeps the full case in Dashboard", () => {
  assert.match(
    mailer,
    /sendPropertyProtectionHostGuestResponseNotice/
  );
  assert.match(
    mailer,
    /Open Reservation Detail \/ Abrir detalle/
  );
  assert.match(mailer, /No charge has been made/);
  assert.match(mailer, /No se ha realizado ningún cargo/);
  assert.match(
    mailer,
    /full case remains inside the authenticated Pin&amp;Go Dashboard/
  );
  assert.doesNotMatch(
    mailer,
    /sendPropertyProtectionHostGuestResponseNotice[\s\S]*guestResponseNote/
  );
});

test("email failure never invalidates the persisted guest response", () => {
  assert.match(
    responseService,
    /DAMAGE_CASE_HOST_NOTIFICATION_UNEXPECTED_ERROR/
  );
  assert.match(responseService, /hostNotification/);
  assert.match(responseService, /alreadyRecorded: false/);
  assert.doesNotMatch(
    responseService,
    /status:\s*DamageCaseStatus\.(CHARGE_BLOCKED|CLOSED_NO_CHARGE)/
  );
});

test("message retry worker retries host response without changing case status", () => {
  assert.match(
    retryWorker,
    /processPropertyProtectionHostResponseRetries/
  );
  assert.match(
    retryWorker,
    /PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE/
  );
  assert.match(
    retryWorker,
    /sendPropertyProtectionHostGuestResponseNotice/
  );
  assert.match(retryWorker, /status: "SENT"/);

  const retryStart = retryWorker.indexOf(
    "async function processPropertyProtectionHostResponseRetries"
  );
  const retryEnd = retryWorker.indexOf(
    "let shuttingDown",
    retryStart
  );
  const retryBlock = retryWorker.slice(retryStart, retryEnd);
  assert.doesNotMatch(retryBlock, /damageCase\.update/);
  assert.doesNotMatch(retryBlock, /CHARGE_BLOCKED/);
});

test("host response notification contains no financial mutation", () => {
  const combined =
    notificationService + responseService + retryWorker;
  assert.doesNotMatch(combined, /paymentIntents/);
  assert.doesNotMatch(combined, /charges\./);
  assert.doesNotMatch(combined, /capture_method/);
  assert.doesNotMatch(combined, /refunds\./);
});
