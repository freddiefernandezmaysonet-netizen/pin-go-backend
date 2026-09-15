import test from "node:test";
import assert from "node:assert/strict";

import { buildCleaningEndSmsBody } from "./messaging.service";

const BASIC = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const EXT = new Set(Array.from("^{}\\[~]|€"));

function gsm7Units(value: string) {
  let units = 0;
  for (const char of value) {
    if (BASIC.has(char)) units += 1;
    else if (EXT.has(char)) units += 2;
    else return null;
  }
  return units;
}

function gsm7Segments(value: string) {
  const units = gsm7Units(value);
  if (units === null) return null;
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

test("cleaning end SMS fits one representative GSM-7 segment", () => {
  const body = buildCleaningEndSmsBody({
    staffName: "Benjamin Ortiz",
    propertyName: "Casa Collores",
    roomName: "Main House",
    endsAt: new Date("2026-09-16T23:00:00.000Z"),
    timezone: "America/Puerto_Rico",
  });

  assert.equal(gsm7Segments(body), 1);
  assert.ok(body.includes("Casa Collores"));
  assert.ok(body.includes("Main House"));
  assert.ok(body.includes("07:00 PM"));
  assert.ok(body.includes("Access/Acceso ended/finalizado"));
  assert.equal(body.includes("Benjamin Ortiz"), false);
});

test("maximum capped cleaning end values remain one GSM-7 segment", () => {
  const body = buildCleaningEndSmsBody({
    propertyName: "X".repeat(40),
    roomName: "Y".repeat(30),
    endsAt: new Date("2026-09-16T23:00:00.000Z"),
    timezone: "America/Puerto_Rico",
  });

  assert.equal(gsm7Segments(body), 1);
  const units = gsm7Units(body);
  assert.ok(units !== null && units <= 160);
});
