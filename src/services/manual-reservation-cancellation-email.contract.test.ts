import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readMailer() {
  return readFile(
    new URL("../lib/mailer.ts", import.meta.url),
    "utf8"
  );
}

function getManualCancellationEmailFunction(source: string) {
  const functionStart = source.indexOf(
    "export async function sendManualReservationGuestCancellationEmail"
  );

  assert.notEqual(functionStart, -1);

  return source.slice(functionStart);
}

test("manual cancellation email supports the reservation guest language", async () => {
  const source = await readMailer();
  const emailFunction =
    getManualCancellationEmailFunction(source);

  assert.match(
    emailFunction,
    /resolveGuestLanguage\(preferredLanguage\)/
  );
  assert.match(emailFunction, /const isSpanish = language === "es"/);
  assert.match(
    emailFunction,
    /Su reservación fue cancelada/
  );
  assert.match(
    emailFunction,
    /Your reservation was cancelled/
  );
});

test("manual cancellation email identifies the host cancellation and reservation", async () => {
  const source = await readMailer();
  const emailFunction =
    getManualCancellationEmailFunction(source);

  assert.match(
    emailFunction,
    /El anfitrión canceló su reservación/
  );
  assert.match(
    emailFunction,
    /The host cancelled your reservation/
  );
  assert.match(emailFunction, /safeReservationNumber/);
  assert.match(emailFunction, /safePropertyName/);
});

test("manual cancellation email renders dates and the host reason", async () => {
  const source = await readMailer();
  const emailFunction =
    getManualCancellationEmailFunction(source);

  assert.match(
    emailFunction,
    /formatBookingDate\(checkIn, dateTimeZone, language\)/
  );
  assert.match(
    emailFunction,
    /formatBookingDate\(checkOut, dateTimeZone, language\)/
  );
  assert.match(
    emailFunction,
    /formatBookingDateTime\(cancelledAt, dateTimeZone, language\)/
  );
  assert.match(
    emailFunction,
    /const safeReason = escapeHtml\(reason\)/
  );
  assert.match(emailFunction, /\$\{safeReason\}/);
});

test("manual cancellation email escapes guest-facing values", async () => {
  const source = await readMailer();
  const emailFunction =
    getManualCancellationEmailFunction(source);

  assert.match(
    emailFunction,
    /const safeReservationNumber = escapeHtml\(reservationNumber\)/
  );
  assert.match(
    emailFunction,
    /const safeGuestName = escapeHtml\(/
  );
  assert.match(
    emailFunction,
    /const safePropertyName = escapeHtml\(propertyName\)/
  );
  assert.match(
    emailFunction,
    /const safeReason = escapeHtml\(reason\)/
  );
});

test("manual cancellation email contains no financial or Direct Booking language", async () => {
  const source = await readMailer();
  const emailFunction =
    getManualCancellationEmailFunction(source);

  assert.doesNotMatch(emailFunction, /stripe/i);
  assert.doesNotMatch(emailFunction, /refund/i);
  assert.doesNotMatch(emailFunction, /reembolso/i);
  assert.doesNotMatch(emailFunction, /payment/i);
  assert.doesNotMatch(emailFunction, /pago/i);
  assert.doesNotMatch(emailFunction, /cancellation policy/i);
  assert.doesNotMatch(emailFunction, /política de cancelación/i);
  assert.doesNotMatch(
    emailFunction,
    /sendDirectBookingGuestCancellationEmail/
  );
});
