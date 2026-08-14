import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readRetryWorker() {
  return readFile(
    new URL("./message.retry.worker.ts", import.meta.url),
    "utf8"
  );
}

function getManualCancellationRetry(source: string) {
  const start = source.indexOf(
    "async function processManualCancellationEmailRetries"
  );
  const end = source.indexOf("let shuttingDown", start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return source.slice(start, end);
}

test("manual cancellation retry selects only its failed logged email type", async () => {
  const retry = getManualCancellationRetry(await readRetryWorker());

  assert.match(retry, /channel:\s*"email"/);
  assert.match(retry, /provider:\s*"resend"/);
  assert.match(retry, /status:\s*"FAILED"/);
  assert.match(retry, /retryCount:\s*\{[\s\S]*?lt:\s*MAX_RETRIES/);
  assert.match(
    retry,
    /"type":"MANUAL_RESERVATION_GUEST_CANCELLATION"/
  );
});

test("manual cancellation retry is isolated by logged reservation property and organization", async () => {
  const retry = getManualCancellationRetry(await readRetryWorker());

  assert.match(retry, /id:\s*reservationId/);
  assert.match(retry, /propertyId:\s*message\.propertyId/);
  assert.match(
    retry,
    /property:\s*\{[\s\S]*?organizationId:\s*message\.organizationId/
  );
  assert.match(
    retry,
    /MANUAL_CANCELLATION_RESERVATION_NOT_FOUND/
  );
});

test("manual cancellation retry rejects reservations outside the host manual cancelled scope", async () => {
  const retry = getManualCancellationRetry(await readRetryWorker());

  assert.match(retry, /reservation\.source !== "MANUAL"/);
  assert.match(
    retry,
    /reservation\.externalProvider !== "PIN_GO_MANUAL"/
  );
  assert.match(retry, /reservation\.status !== "CANCELLED"/);
  assert.match(
    retry,
    /MANUAL_CANCELLATION_RESERVATION_SCOPE_INVALID/
  );
});

test("manual cancellation retry rebuilds guest content from the persisted reservation", async () => {
  const retry = getManualCancellationRetry(await readRetryWorker());

  assert.match(
    retry,
    /sendManualReservationGuestCancellationEmail\(\{[\s\S]*?reservationNumber:\s*reservation\.reservationNumber[\s\S]*?guestName:\s*reservation\.guestName[\s\S]*?checkIn:\s*reservation\.checkIn[\s\S]*?checkOut:\s*reservation\.checkOut[\s\S]*?reason:\s*reservation\.cancellationReason/
  );
  assert.doesNotMatch(retry, /retryPayload\./);
  assert.doesNotMatch(retry, /stripe/i);
  assert.doesNotMatch(retry, /refund/i);
  assert.doesNotMatch(retry, /payment/i);
});

test("manual cancellation retry protects the current guest destination", async () => {
  const retry = getManualCancellationRetry(await readRetryWorker());

  assert.match(
    retry,
    /const guestEmail = String\(reservation\.guestEmail \?\? ""\)\.trim\(\)/
  );
  assert.match(retry, /guestEmail !== message\.to\.trim\(\)/);
  assert.match(
    retry,
    /MANUAL_CANCELLATION_EMAIL_DESTINATION_MISSING/
  );
});

test("manual cancellation retry records success and stops non-retryable failures", async () => {
  const source = await readRetryWorker();
  const retry = getManualCancellationRetry(source);

  assert.match(
    retry,
    /messageLog\.update\(\{[\s\S]*?status:\s*"SENT"[\s\S]*?retryCount:\s*\{[\s\S]*?increment:\s*1/
  );
  assert.match(
    retry,
    /type:\s*"MANUAL_RESERVATION_GUEST_CANCELLATION"[\s\S]*?channel:\s*"email"[\s\S]*?status:\s*"SENT"/
  );
  assert.match(retry, /finalFailure \? "FAILED_FINAL" : "FAILED"/);
  assert.match(
    source,
    /await processManualCancellationEmailRetries\(\)/
  );
});
