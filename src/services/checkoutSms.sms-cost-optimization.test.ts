import test from "node:test";
import assert from "node:assert/strict";

import { buildCheckoutMessage } from "./checkoutSms.service";

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

for (const language of ["es", "en"] as const) {
  test(`${language} checkout SMS stays GSM-7 and fits one representative segment`, () => {
    const body = buildCheckoutMessage({
      guestName: "Freddie Fernández",
      propertyName: "Cabaña Peñón del Río",
      checkoutTime: language === "es" ? "11:00 a. m." : "11:00 AM",
      language,
    });

    assert.equal(gsm7Segments(body), 1);
    assert.match(body, /Pin&Go/);
    assert.match(body, /11:00/);
    assert.doesNotMatch(body, /Freddie/i);
    assert.doesNotMatch(body, /[ñáéíóú]/i);
  });
}
