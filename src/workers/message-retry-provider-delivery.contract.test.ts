import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readWorker() {
  return readFile(
    new URL("./message.retry.worker.ts", import.meta.url),
    "utf8"
  );
}

function sliceFunction(
  source: string,
  name: string,
  nextName: string
) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start);

  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must exist`);

  return source.slice(start, end);
}

const emailRetryFunctions = [
  ["processGuestAccessEmailRetries", "processManualCancellationEmailRetries"],
  ["processManualCancellationEmailRetries", "processPropertyProtectionDamageNoticeRetries"],
  ["processPropertyProtectionDamageNoticeRetries", "processPropertyProtectionGuestClosureRetries"],
  ["processPropertyProtectionGuestClosureRetries", "processPropertyProtectionHostResponseRetries"],
] as const;

test("legacy FAILED email retry eligibility remains intact while provider FAILED is additive", async () => {
  const source = await readWorker();

  for (const [name, nextName] of emailRetryFunctions) {
    const fn = sliceFunction(source, name, nextName);

    assert.match(fn, /provider:\s*"resend"/);
    assert.match(fn, /\{\s*status:\s*"FAILED"\s*\}/);
    assert.match(
      fn,
      /status:\s*"SENT"[\s\S]*?providerDeliveryStatus:\s*"FAILED"/
    );

    assert.doesNotMatch(
      fn,
      /providerDeliveryStatus:\s*"(?:BOUNCED|SUPPRESSED|COMPLAINED|UNDELIVERED)"/
    );
  }

  const hostStart = source.indexOf(
    "async function processPropertyProtectionHostResponseRetries"
  );
  const hostEnd = source.indexOf("let shuttingDown", hostStart);
  const hostFn = source.slice(hostStart, hostEnd);

  assert.match(hostFn, /\{\s*status:\s*"FAILED"\s*\}/);
  assert.match(
    hostFn,
    /status:\s*"SENT"[\s\S]*?providerDeliveryStatus:\s*"FAILED"/
  );
});

test("successful Resend retries reset only prior provider outcome evidence", async () => {
  const source = await readWorker();

  const resetCount =
    source.match(/providerDeliveryStatus:\s*null/g)?.length ?? 0;

  assert.equal(resetCount, 5);

  for (const field of [
    "providerDeliveryStatus",
    "providerStatusUpdatedAt",
    "providerErrorCode",
    "providerErrorMessage",
    "deliveredAt",
  ]) {
    assert.match(
      source,
      new RegExp(`${field}:\\s*null`)
    );
  }
});

test("SMS legacy retry selector is unchanged by email provider outcome recovery", async () => {
  const source = await readWorker();
  const start = source.indexOf("async function processRetries");
  const end = source.indexOf(
    "async function processGuestAccessEmailRetries",
    start
  );
  const smsRetry = source.slice(start, end);

  assert.match(
    smsRetry,
    /channel:\s*"sms"[\s\S]*?status:\s*"FAILED"[\s\S]*?retryCount/
  );
  assert.doesNotMatch(smsRetry, /providerDeliveryStatus/);
});
