import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const mailer = readFileSync(
  new URL("../lib/mailer.ts", import.meta.url),
  "utf8"
);
const service = readFileSync(
  new URL("./damage-case-guest-notification.service.ts", import.meta.url),
  "utf8"
);
const route = readFileSync(
  new URL("../routes/dashboard.damage-cases.routes.ts", import.meta.url),
  "utf8"
);

const mailerStart = mailer.indexOf(
  "export async function sendPropertyProtectionGuestDamageNotice"
);
const mailerEnd = mailer.indexOf(
  "export async function sendReviewInvitationEmail",
  mailerStart
);
const noticeMailer = mailer.slice(mailerStart, mailerEnd);

test("Property Protection email is a brief Manage Reservation notice", () => {
  assert.match(noticeMailer, /Manage reservation/);
  assert.match(noticeMailer, /Administrar reservación/);
  assert.match(noticeMailer, /No charge has been made for this update/);
  assert.match(noticeMailer, /No se ha realizado ningún cargo por esta actualización/);
  assert.match(noticeMailer, /manageReservationUrl/);
});

test("email does not embed Damage Case amounts, description, or evidence", () => {
  assert.doesNotMatch(noticeMailer, /requestedAmount/);
  assert.doesNotMatch(noticeMailer, /approvedAmount/);
  assert.doesNotMatch(noticeMailer, /maxDamageLiabilityAmount/);
  assert.doesNotMatch(noticeMailer, /evidence/);
  assert.doesNotMatch(noticeMailer, /damageCase/);
});

test("notification is idempotent and logged before state transition", () => {
  assert.match(service, /PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE/);
  assert.match(service, /messageLog\.findFirst/);
  assert.match(service, /status: "SENT"/);
  assert.match(service, /sendLoggedEmail/);
  assert.match(service, /property-protection-damage-notice-\$\{damageCase\.id\}/);
  assert.match(service, /DamageCaseStatus\.GUEST_NOTIFIED/);
  assert.match(service, /guestNotifiedAt: new Date\(\)/);
});

test("failed delivery leaves the case pending and does not claim notification", () => {
  const failureBranch = service.match(
    /if \(!delivery\.ok \|\| delivery\.status !== "SENT"\) \{[\s\S]*?return \{[\s\S]*?DAMAGE_CASE_GUEST_NOTIFICATION_DELIVERY_FAILED[\s\S]*?\};[\s\S]*?\}/
  );
  assert.ok(failureBranch);
  const transitionIndex = service.indexOf(
    "const updated = await input.prisma.damageCase.updateMany"
  );
  assert.ok(transitionIndex > service.indexOf(failureBranch[0]));
});

test("host approval invokes notice but still contains no Stripe collection", () => {
  assert.match(route, /notifyGuestOfApprovedDamageCase/);
  assert.doesNotMatch(service, /paymentIntents/);
  assert.doesNotMatch(service, /charges\./);
  assert.doesNotMatch(service, /capture_method/);
  assert.doesNotMatch(service, /stripeDamagePaymentMethodId/);
});
