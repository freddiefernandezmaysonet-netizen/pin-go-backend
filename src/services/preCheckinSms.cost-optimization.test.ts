import test from "node:test";
import assert from "node:assert/strict";

import { buildPreCheckinMessage } from "./preCheckinSms.service";

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

const MAPS_LINK =
  "https://www.google.com/maps/search/?api=1&query=18.0,-66.0";
const VERIFY_LINK =
  `https://api.pin-ngo.com/guest/verify/${"a".repeat(64)}`;

test("verified Spanish pre-checkin stays GSM-7 and fits one representative segment", () => {
  const body = buildPreCheckinMessage({
    guestName: "Freddie",
    propertyName: "Casa Collores",
    checkInTime: "04:00 PM",
    address: "Carr 1 Km 1, Puerto Rico",
    mapsLink: MAPS_LINK,
    verifyLink: null,
    language: "es",
  });

  assert.equal(gsm7Segments(body), 1);
  assert.match(body, /Ubicacion:/);
  assert.match(body, /Te esperamos\./);
  assert.doesNotMatch(body, /Carr 1 Km 1/);
  assert.doesNotMatch(body, /🛡️/u);
  assert.doesNotMatch(body.toLowerCase(), /verific/);
});

test("pending Spanish pre-checkin stays GSM-7 and fits two representative segments", () => {
  const body = buildPreCheckinMessage({
    guestName: "Freddie",
    propertyName: "Casa Collores",
    checkInTime: "04:00 PM",
    address: "Carr 1 Km 1, Puerto Rico",
    mapsLink: MAPS_LINK,
    verifyLink: VERIFY_LINK,
    language: "es",
  });

  assert.equal(gsm7Segments(body), 2);
  assert.match(body, /Verificacion requerida:/);
  assert.match(body, new RegExp(VERIFY_LINK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(body, /Carr 1 Km 1/);
  assert.doesNotMatch(body, /🛡️/u);
});

test("property address fallback preserves a clickable Google Maps search URL", () => {
  const address = "Carr 926 km 0.5 Bo Collores";
  const mapsLink =
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

  const body = buildPreCheckinMessage({
    propertyName: "Casa Collores",
    checkInTime: "04:00 PM",
    address,
    mapsLink,
    verifyLink: null,
    language: "en",
  });

  assert.match(
    body,
    /https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Carr%20926%20km%200\.5%20Bo%20Collores/
  );
});

test("address is used only as compact fallback when no map link exists", () => {
  const body = buildPreCheckinMessage({
    propertyName: "Casa Águila del Mar",
    checkInTime: "04:00 p. m.",
    address:
      "123 Calle Principal, Sector Muy Largo, Municipio, Puerto Rico, 00999",
    mapsLink: null,
    verifyLink: null,
    language: "es",
  });

  assert.notEqual(gsm7Segments(body), null);
  assert.match(body, /Casa Aguila del Mar/);
  assert.match(body, /Ubicacion: 123 Calle Principal/);
  assert.doesNotMatch(body, /Á/);
});
