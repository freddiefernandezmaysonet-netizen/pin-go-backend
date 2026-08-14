import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readCleanerCancellationNotificationService() {
  return readFile(
    new URL(
      "./manual-reservation-cleaner-cancellation-notification.service.ts",
      import.meta.url
    ),
    "utf8"
  );
}

test("cleaner cancellation notification only accepts cancelled manual reservations", async () => {
  const source =
    await readCleanerCancellationNotificationService();

  assert.match(
    source,
    /reservation\.source[\s\S]*?toUpperCase\(\) === "MANUAL"/
  );
  assert.match(
    source,
    /reservation\.externalProvider[\s\S]*?toUpperCase\(\) === "PIN_GO_MANUAL"/
  );
  assert.match(
    source,
    /reservation\.status !== ReservationStatus\.CANCELLED/
  );
  assert.match(
    source,
    /reason:\s*"not_cancelled_manual_reservation"/
  );
});

test("notification uses only a cleaner already related to the reservation", async () => {
  const source =
    await readCleanerCancellationNotificationService();

  assert.match(
    source,
    /cleaningConfirmation\.findFirst\(\{[\s\S]*?reservationId:\s*reservation\.id/
  );
  assert.match(
    source,
    /staffAssignment\.findFirst\(\{[\s\S]*?reservationId:\s*reservation\.id/
  );
  assert.match(
    source,
    /confirmation\?\.staffMemberId \?\?\s*staffAssignment\?\.staffMemberId/
  );
  assert.doesNotMatch(source, /selectNextStaff/);
  assert.doesNotMatch(
    source,
    /createCleaningConfirmation/
  );
  assert.doesNotMatch(source, /staffMember\.create/);
});

test("cleaner lookup is isolated by reservation organization", async () => {
  const source =
    await readCleanerCancellationNotificationService();

  assert.match(
    source,
    /staffMember\.findFirst\(\{[\s\S]*?id:\s*staffMemberId,[\s\S]*?organizationId:\s*reservation\.property\.organizationId/
  );
  assert.match(
    source,
    /reason:\s*"cleaner_phone_not_available"/
  );
});

test("cleaner cancellation notification is idempotent", async () => {
  const source =
    await readCleanerCancellationNotificationService();
  const duplicateCheck = source.indexOf(
    "await db.messageDispatchLog.findFirst"
  );
  const smsSend = source.indexOf(
    "const sms = await sendSms"
  );

  assert.notEqual(duplicateCheck, -1);
  assert.notEqual(smsSend, -1);
  assert.ok(duplicateCheck < smsSend);

  assert.match(
    source,
    /type:\s*DISPATCH_TYPE,[\s\S]*?channel:\s*"sms",[\s\S]*?status:\s*"SENT"/
  );
  assert.match(
    source,
    /reason:\s*"already_notified"/
  );
});

test("cleaner receives a bilingual cancellation notice without confirmation link", async () => {
  const source =
    await readCleanerCancellationNotificationService();

  assert.match(source, /Pin&Go — Limpieza cancelada/);
  assert.match(source, /Pin&Go — Cleaning cancelled/);
  assert.match(
    source,
    /No se requiere la limpieza asociada/
  );
  assert.match(
    source,
    /cleaning associated with this reservation is no longer required/
  );
  assert.match(source, /await sendSms\(/);

  assert.doesNotMatch(source, /confirmUrl/);
  assert.doesNotMatch(source, /buildConfirmUrl/);
  assert.doesNotMatch(source, /confirmation\.token/);
});

test("cleaner notification persists sent and failed evidence", async () => {
  const source =
    await readCleanerCancellationNotificationService();

  assert.match(
    source,
    /messageLog\.create\(\{[\s\S]*?status:\s*"SENT"/
  );
  assert.match(
    source,
    /messageDispatchLog\.create\(\{[\s\S]*?status:\s*"SENT"/
  );
  assert.match(
    source,
    /messageLog[\s\S]*?status:\s*"FAILED"/
  );
  assert.match(
    source,
    /messageDispatchLog[\s\S]*?status:\s*"FAILED"/
  );
});

test("cleaner notification does not touch access lifecycle", async () => {
  const source =
    await readCleanerCancellationNotificationService();

  assert.doesNotMatch(source, /ttlock/i);
  assert.doesNotMatch(source, /nfcAssignment/);
  assert.doesNotMatch(source, /accessGrant/);
  assert.doesNotMatch(source, /reconcileReservation/);
});
