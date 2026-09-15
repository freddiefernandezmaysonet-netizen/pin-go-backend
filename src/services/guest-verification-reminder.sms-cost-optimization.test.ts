import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildVerificationReminderSms } from "./guest-verification-reminder.service";

const GSM_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
  )
);
const GSM_EXTENDED = new Set(Array.from("^{}\\[~]|€"));

function gsm7Units(value: string) {
  let units = 0;
  for (const char of value) {
    if (GSM_BASIC.has(char)) {
      units += 1;
      continue;
    }
    if (GSM_EXTENDED.has(char)) {
      units += 2;
      continue;
    }
    return null;
  }
  return units;
}

function gsm7Segments(value: string) {
  const units = gsm7Units(value);
  if (units === null) return null;
  if (units <= 160) return 1;
  return Math.ceil(units / 153);
}

const VERIFY_LINK =
  `https://api.pin-ngo.com/guest/verify/${"a".repeat(64)}`;

for (const language of ["es", "en"] as const) {
  test(`${language} verification reminder stays GSM-7 and fits one representative segment`, () => {
    const body = buildVerificationReminderSms({
      guestName: "Freddie Fernández",
      propertyName: "Casa Collores",
      reservationNumber: "PG-2026-123456",
      verificationUrl: VERIFY_LINK,
      language,
    });

    assert.equal(gsm7Segments(body), 1);
    assert.match(body, new RegExp(VERIFY_LINK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(body, /Freddie/i);
    assert.doesNotMatch(body, /Casa Collores/i);
    assert.doesNotMatch(body, /PG-2026-123456/i);
  });
}

test("verification URL remains masked in MessageLog writes", () => {
  const source = readFileSync(
    new URL("./guest-verification-reminder.service.ts", import.meta.url),
    "utf8"
  );

  const matches = source.match(/maskVerificationUrl\(\s*smsBody\s*\)/g) ?? [];
  assert.equal(matches.length, 2);
});
