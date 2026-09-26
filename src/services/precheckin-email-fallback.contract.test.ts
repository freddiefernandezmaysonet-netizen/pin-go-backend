import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("legacy pre-checkin delivers email independently before optional SMS consent", async () => {
  const worker = await read("../workers/reservation.worker.ts");

  assert.match(
    worker,
    /sendPreCheckinEmail/
  );
  assert.match(
    worker,
    /guestEmail:\s*\{\s*not:\s*null/
  );
  assert.match(
    worker,
    /guestPhone:\s*\{\s*not:\s*null/
  );

  const emailCall = worker.indexOf(
    "await sendPreCheckinEmail"
  );
  const consentGate = worker.indexOf(
    "!hasGuestSmsConsent"
  );

  assert.ok(emailCall >= 0);
  assert.ok(consentGate >= 0);
  assert.ok(
    emailCall < consentGate,
    "email fallback must execute before the SMS consent gate"
  );
});

test("pre-checkin email is first-class logged communication evidence", async () => {
  const delivery = await read(
    "./email-delivery.service.ts"
  );
  const precheckin = await read(
    "./preCheckinSms.service.ts"
  );

  assert.match(
    delivery,
    /\| "PRECHECKIN"/
  );
  assert.match(
    precheckin,
    /type:\s*"PRECHECKIN"/
  );
  assert.match(
    precheckin,
    /channel:\s*"email"/
  );
  assert.match(
    precheckin,
    /sendLoggedEmail\(/
  );
});

test("modern communications adapter supports PRECHECKIN email replay", async () => {
  const adapter = await read(
    "./guest-journey-communications-delivery-adapter.service.ts"
  );
  const mailer = await read("../lib/mailer.ts");

  assert.match(
    adapter,
    /case "PRECHECKIN":/
  );
  assert.match(
    adapter,
    /sendGuestPreCheckinEmail\(/
  );
  assert.match(
    mailer,
    /export async function sendGuestPreCheckinEmail/
  );
  assert.match(
    mailer,
    /getGuestPreCheckinEmailSubject/
  );
});
