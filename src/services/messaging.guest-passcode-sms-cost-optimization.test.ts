import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGuestPasscodeSmsBody,
  maskSensitiveBody,
} from "./messaging.service";

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

const VALID_UNTIL = new Date("2026-09-15T22:00:00.000Z");

test("Spanish guest passcode SMS stays GSM-7 and fits one segment", () => {
  const body = buildGuestPasscodeSmsBody({
    guestName: "Freddie Fernández",
    code: "123456",
    validUntil: VALID_UNTIL,
    timezone: "America/Puerto_Rico",
    language: "es",
  });

  assert.equal(gsm7Segments(body), 1);
  assert.match(body, /Codigo: 123456/);
  assert.match(body, /keypad/);
  assert.match(body, /desbloqueo/);
  assert.match(body, /Valido hasta/);
  assert.doesNotMatch(body, /🔐|⚠️|🕒|—/u);
});

test("English guest passcode SMS stays GSM-7 and fits one segment", () => {
  const body = buildGuestPasscodeSmsBody({
    guestName: "Freddie Fernández",
    code: "123456",
    validUntil: VALID_UNTIL,
    timezone: "America/Puerto_Rico",
    language: "en",
  });

  assert.equal(gsm7Segments(body), 1);
  assert.match(body, /Code: 123456/);
  assert.match(body, /keypad/);
  assert.match(body, /unlock/);
  assert.match(body, /Valid until/);
  assert.doesNotMatch(body, /🔐|⚠️|🕒|—/u);
});

test("compact passcode format is masked before MessageLog persistence", () => {
  const spanish = maskSensitiveBody(
    "Pin&Go acceso. Codigo: 123456. En keypad, ingresa el codigo."
  );
  const english = maskSensitiveBody(
    "Pin&Go access. Code: 987654. Enter code on keypad."
  );

  assert.doesNotMatch(spanish, /123456/);
  assert.match(spanish, /Codigo: \*+56/);
  assert.doesNotMatch(english, /987654/);
  assert.match(english, /Code: \*+54/);
});
