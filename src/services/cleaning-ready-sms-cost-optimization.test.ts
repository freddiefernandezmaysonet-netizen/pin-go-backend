import test from "node:test";
import assert from "node:assert/strict";

import { buildCleaningReadySmsBody } from "./cleaning-ready-sms-body.service";

const BASIC = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const EXT = new Set(Array.from("^{}\\[~]|€"));

function gsm7Segments(value: string) {
  let units = 0;
  for (const char of value) {
    if (BASIC.has(char)) units += 1;
    else if (EXT.has(char)) units += 2;
    else return null;
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

test("cleaning ready SMS fits one representative GSM-7 segment", () => {
  const body = buildCleaningReadySmsBody({
    propertyName: "Casa Collores",
    roomName: "Main House",
    start: "09/16/2026, 11:00 AM",
    end: "09/16/2026, 07:00 PM",
  });

  assert.equal(gsm7Segments(body), 1);
  assert.ok(body.includes("Casa Collores"));
  assert.ok(body.includes("Main House"));
  assert.ok(body.includes("11:00 AM"));
  assert.ok(body.includes("07:00 PM"));
});

test("maximum capped variable lengths still fit one GSM-7 segment", () => {
  const body = buildCleaningReadySmsBody({
    propertyName: "X".repeat(40),
    roomName: "Y".repeat(30),
    start: "Z".repeat(40),
    end: "W".repeat(40),
  });

  assert.equal(gsm7Segments(body), 1);
});
