import test from "node:test";
import assert from "node:assert/strict";
import { buildCleaningConfirmationSmsBody } from "./cleaning-confirmation-sms-body.service";

const BASIC = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const EXT = new Set(Array.from("^{}\\[~]|€"));

function segments(value: string) {
  let units = 0;
  for (const char of value) {
    if (BASIC.has(char)) units += 1;
    else if (EXT.has(char)) units += 2;
    else return null;
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

const token = "0123456789abcdef".repeat(4);
const url = `https://api.pin-ngo.com/cleaning/confirm/${token}`;

test("cleaning confirmation stays GSM-7 and fits two segments", () => {
  const body = buildCleaningConfirmationSmsBody({
    propertyName: "Casa Collores",
    roomName: "Main House",
    checkOutText: "09/16/2026, 11:00 AM",
    confirmUrl: url,
  });

  assert.equal(segments(body), 2);
  assert.ok(body.includes(token));
  assert.ok(body.includes("Casa Collores"));
  assert.ok(body.includes("Main House"));
  assert.equal(body.split(token).length - 1, 1);
});

test("variable text is normalized without UCS-2", () => {
  const body = buildCleaningConfirmationSmsBody({
    propertyName: "Cabana Penon del Rio - Vista increible 1234567890",
    roomName: "Unidad Premium 1234567890",
    checkOutText: "09/16/2026, 11:00 AM",
    confirmUrl: url,
  });

  assert.equal(segments(body), 2);
  assert.ok(body.includes(token));
});
