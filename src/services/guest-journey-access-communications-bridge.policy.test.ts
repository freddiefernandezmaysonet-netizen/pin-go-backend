import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGuestAccessCommunicationOutbox,
  filterAlreadyOwnedGuestAccessDeliveries,
  hasGuestSmsConsent,
} from "./guest-journey-access-communications-bridge.policy";

const base = {
  organizationId: "org1",
  propertyId: "prop1",
  reservationId: "res1",
  reservationNumber: "PG-2026-000044",
  guestEmail: "Guest@Example.com",
  guestPhone: "+17875550123",
  preferredLanguage: "es-PR",
  externalRaw: { consent: { acceptedAt: "2026-08-31T18:00:00Z", smsConsent: true } },
  accessGrantId: "grant1",
  accessCodeHash: "codehash1",
  validFrom: new Date("2026-08-31T19:00:00Z"),
  validUntil: new Date("2026-09-01T15:00:00Z"),
};

test("creates email and consented SMS without passcode plaintext", () => {
  const rows = buildGuestAccessCommunicationOutbox(base);
  assert.deepEqual(rows.map((row) => row.channel).sort(), ["email", "sms"]);
  assert.ok(rows.every((row) => row.status === "APMS_PENDING"));
  assert.doesNotMatch(JSON.stringify(rows), /1234567/);
});

test("preserves legacy email envelope and Spanish subject", () => {
  const email = buildGuestAccessCommunicationOutbox(base).find((row) => row.channel === "email")!;
  const parsed = JSON.parse(email.body);
  assert.equal(parsed.kind, "PIN_GO_EMAIL_DELIVERY");
  assert.equal(parsed.type, "GUEST_ACCESS_PASSCODE");
  assert.equal(parsed.subject, "Su acceso Pin&Go está listo - Reservación #PG-2026-000044");
  assert.equal(parsed.retryPayload.accessGrantId, "grant1");
});

test("SMS requires durable consent", () => {
  assert.equal(hasGuestSmsConsent({ consent: { acceptedAt: "x", stayNotificationsConsent: true } }), true);
  const rows = buildGuestAccessCommunicationOutbox({
    ...base,
    externalRaw: { consent: { acceptedAt: "x", smsConsent: false, stayNotificationsConsent: false } },
  });
  assert.deepEqual(rows.map((row) => row.channel), ["email"]);
});

test("same credential/window/destination is deterministic", () => {
  assert.deepEqual(
    buildGuestAccessCommunicationOutbox(base).map((row) => row.id),
    buildGuestAccessCommunicationOutbox(base).map((row) => row.id)
  );
});

test("credential, window or recipient mutation creates new logical delivery", () => {
  const original = buildGuestAccessCommunicationOutbox(base).map((row) => row.id);
  assert.notDeepEqual(original, buildGuestAccessCommunicationOutbox({ ...base, accessCodeHash: "codehash2" }).map((row) => row.id));
  assert.notDeepEqual(original, buildGuestAccessCommunicationOutbox({ ...base, validUntil: new Date("2026-09-01T16:00:00Z") }).map((row) => row.id));
  assert.notDeepEqual(original, buildGuestAccessCommunicationOutbox({ ...base, guestEmail: "new@example.com" }).map((row) => row.id));
});

test("existing SENT/FAILED ownership suppresses competing first-send", () => {
  const rows = buildGuestAccessCommunicationOutbox(base);
  const filtered = filterAlreadyOwnedGuestAccessDeliveries({
    rows,
    accessGrantId: "grant1",
    accessGrantUpdatedAt: new Date("2026-08-31T18:30:00Z"),
    existing: [
      {
        channel: "sms",
        to: "+17875550123",
        status: "FAILED",
        accessGrantId: "grant1",
        body: "masked",
        createdAt: new Date("2026-08-31T18:31:00Z"),
      },
      {
        channel: "email",
        to: "guest@example.com",
        status: "SENT",
        accessGrantId: null,
        body: JSON.stringify({ kind: "PIN_GO_EMAIL_DELIVERY", retryPayload: { accessGrantId: "grant1" } }),
        createdAt: new Date("2026-08-31T18:31:00Z"),
      },
    ],
  });
  assert.equal(filtered.length, 0);
});

test("delivery older than latest grant mutation cannot suppress new obligation", () => {
  const rows = buildGuestAccessCommunicationOutbox(base);
  const filtered = filterAlreadyOwnedGuestAccessDeliveries({
    rows,
    accessGrantId: "grant1",
    accessGrantUpdatedAt: new Date("2026-08-31T18:40:00Z"),
    existing: [{
      channel: "sms",
      to: "+17875550123",
      status: "SENT",
      accessGrantId: "grant1",
      body: "old",
      createdAt: new Date("2026-08-31T18:31:00Z"),
    }],
  });
  assert.deepEqual(filtered.map((row) => row.channel).sort(), ["email", "sms"]);
});
