import test from "node:test";
import assert from "node:assert/strict";

import { buildManualCleanerCancellationSmsBody } from "./manual-reservation-cleaner-cancellation-notification.service";

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

test("manual cleaner cancellation SMS fits one representative GSM-7 segment", () => {
  const body = buildManualCleanerCancellationSmsBody({
    reservationNumber: "PG-2026-123456",
    propertyName: "Casa Collores",
    checkIn: new Date("2026-09-16T20:00:00.000Z"),
    checkOut: new Date("2026-09-18T15:00:00.000Z"),
    timeZone: "America/Puerto_Rico",
  });

  assert.equal(gsm7Segments(body), 1);
  assert.ok(body.includes("PG-2026-123456"));
  assert.ok(body.includes("Casa Collores"));
  assert.ok(body.includes("09/16 04:00 PM"));
  assert.ok(body.includes("09/18 11:00 AM"));
  assert.ok(body.includes("No cleaning/no limpieza"));
});

test("maximum capped manual cleaner cancellation values remain one GSM-7 segment", () => {
  const body = buildManualCleanerCancellationSmsBody({
    reservationNumber: "R".repeat(40),
    propertyName: "P".repeat(40),
    checkIn: new Date("2026-09-16T20:00:00.000Z"),
    checkOut: new Date("2026-09-18T15:00:00.000Z"),
    timeZone: "America/Puerto_Rico",
  });

  assert.equal(gsm7Segments(body), 1);
  const units = gsm7Units(body);
  assert.ok(units !== null && units <= 160);
});

test("Unicode in reservation and property text does not force UCS-2", () => {
  const body = buildManualCleanerCancellationSmsBody({
    reservationNumber: "PG—2026—Ñ123",
    propertyName: "Cabaña Peñón del Río",
    checkIn: new Date("2026-09-16T20:00:00.000Z"),
    checkOut: new Date("2026-09-18T15:00:00.000Z"),
    timeZone: "America/Puerto_Rico",
  });

  assert.equal(gsm7Segments(body), 1);
  assert.doesNotMatch(body, /[ñáéíóú—]/i);
});
