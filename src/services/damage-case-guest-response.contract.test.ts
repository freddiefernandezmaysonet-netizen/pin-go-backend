import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const schema = readFileSync(
  new URL("../../prisma/schema.prisma", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260922204500_damage_case_guest_response_non_charging/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const service = readFileSync(
  new URL("./damage-case-guest-response.service.ts", import.meta.url),
  "utf8"
);
const guestReadModel = readFileSync(
  new URL("./guest-cancellation.service.ts", import.meta.url),
  "utf8"
);
const route = readFileSync(
  new URL("../routes/public-booking.routes.ts", import.meta.url),
  "utf8"
);

test("guest Damage Case response is persisted separately from operational status", () => {
  assert.match(schema, /enum DamageCaseGuestResponse/);
  assert.match(schema, /PENDING/);
  assert.match(schema, /ACKNOWLEDGED/);
  assert.match(schema, /ACCEPTED/);
  assert.match(schema, /DISPUTED/);
  assert.match(schema, /guestResponse\s+DamageCaseGuestResponse/);
  assert.match(schema, /guestRespondedAt\s+DateTime\?/);
  assert.match(schema, /guestResponseNote\s+String\?/);
  assert.match(schema, /guestResponseVersion\s+String\?/);
});

test("migration adds response evidence without financial mutations", () => {
  assert.match(migration, /CREATE TYPE "DamageCaseGuestResponse"/);
  assert.match(migration, /ALTER TABLE "DamageCase"/);
  assert.match(migration, /DEFAULT 'PENDING'/);
  assert.doesNotMatch(migration, /PaymentIntent|charge|hold|capture|refund/i);
});

test("guest response endpoint reuses the existing guest token", () => {
  assert.match(
    route,
    /\/manage\/:guestToken\/property-protection-case\/respond/
  );
  assert.match(route, /recordGuestDamageCaseResponse/);
  assert.match(route, /req\.body\?\.action/);
  assert.match(route, /req\.body\?\.note/);
  assert.match(route, /Cache-Control", "no-store"/);
});

test("only notified cases accept a response", () => {
  assert.match(
    service,
    /damageCase\.status !== DamageCaseStatus\.GUEST_NOTIFIED/
  );
  assert.match(service, /DAMAGE_CASE_GUEST_RESPONSE_NOT_READY/);
  assert.doesNotMatch(
    service,
    /status:\s*DamageCaseStatus\.(CHARGE_BLOCKED|CLOSED_NO_CHARGE)/
  );
});

test("acknowledgement can advance but final responses cannot be overwritten", () => {
  assert.match(service, /DamageCaseGuestResponse\.ACCEPTED/);
  assert.match(service, /DamageCaseGuestResponse\.DISPUTED/);
  assert.match(service, /DAMAGE_CASE_GUEST_RESPONSE_FINAL/);
  assert.match(service, /guestResponse: damageCase\.guestResponse/);
  assert.match(service, /DAMAGE_CASE_GUEST_RESPONSE_CONFLICT/);
});

test("dispute requires a bounded explanation", () => {
  assert.match(
    service,
    /action === "DISPUTED" && !note/
  );
  assert.match(service, /DAMAGE_CASE_GUEST_RESPONSE_NOTE_REQUIRED/);
  assert.match(service, /MAX_RESPONSE_NOTE_LENGTH = 2000/);
  assert.match(service, /DAMAGE_CASE_GUEST_RESPONSE_NOTE_TOO_LONG/);
});

test("same response is idempotent, including optimistic concurrency", () => {
  assert.match(service, /alreadyRecorded: true/);
  assert.match(service, /damageCase\.updateMany/);
  assert.match(service, /if \(updated\.count !== 1\)/);
  assert.match(service, /prisma\.damageCase\.findUnique/);
});

test("guest response retains explicit non-charging boundary", () => {
  assert.match(service, /collectionStatus: "NO_CHARGE_MADE"/);
  assert.doesNotMatch(service, /paymentIntents/);
  assert.doesNotMatch(service, /charges\./);
  assert.doesNotMatch(service, /capture_method/);
  assert.doesNotMatch(service, /refunds\./);
  assert.doesNotMatch(route, /CHARGE_BLOCKED/);
});

test("guest response is exposed by the existing case read model", () => {
  assert.match(guestReadModel, /guestResponse: true/);
  assert.match(guestReadModel, /guestRespondedAt: true/);
  assert.match(guestReadModel, /guestResponseNote: true/);
  assert.match(guestReadModel, /guestResponseVersion: true/);
  assert.match(
    guestReadModel,
    /guestResponse: damageCase\.guestResponse/
  );
});

test("expired tokens and non-direct reservations remain blocked", () => {
  assert.match(service, /guestTokenExpiresAt: \{ gt: new Date\(\) \}/);
  assert.match(service, /RESERVATION_NOT_FOUND_OR_TOKEN_EXPIRED/);
  assert.match(service, /NOT_DIRECT_BOOKING_RESERVATION/);
  assert.match(service, /propertyProtectionRequiredSnapshot !== true/);
});
