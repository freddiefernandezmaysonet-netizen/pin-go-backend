import assert from "node:assert/strict";
import test from "node:test";
import { resolveStaffLanguage, parseStaffLanguage, getStaffIntlLocale } from "./staff-language.service.js";
import { buildCleaningConfirmationSmsBody } from "./cleaning-confirmation-sms-body.service.js";
import { buildCleaningReadySmsBody } from "./cleaning-ready-sms-body.service.js";
import { buildCleanerFollowupSms } from "./cleaning-followup-sms-body.service.js";
import { buildCleaningStartSmsBody, buildCleaningEndSmsBody } from "./messaging.service.js";
import { buildManualCleanerCancellationSmsBody } from "./manual-reservation-cleaner-cancellation-notification.service.js";

test("staff language resolver is strict on writes and safe on reads", () => {
  assert.equal(resolveStaffLanguage("es"), "es");
  assert.equal(resolveStaffLanguage("EN"), "en");
  assert.equal(resolveStaffLanguage(null), "en");
  assert.equal(parseStaffLanguage("ES"), "es");
  assert.throws(() => parseStaffLanguage("fr"), /STAFF_PREFERRED_LANGUAGE_INVALID/);
  assert.equal(getStaffIntlLocale("es"), "es-US");
});

test("cleaner confirmation is single-language", () => {
  const base={propertyName:"Casa",roomName:"A",checkOutText:"10/03 11:00 AM",confirmUrl:"https://api.example/c"};
  const es=buildCleaningConfirmationSmsBody({...base,language:"es"});
  const en=buildCleaningConfirmationSmsBody({...base,language:"en"});
  assert.match(es,/limpieza/i); assert.match(es,/Propiedad:/); assert.doesNotMatch(es,/Property:|Confirm:/);
  assert.match(en,/cleaning/i); assert.match(en,/Property:/); assert.doesNotMatch(en,/Propiedad:|Confirma:/);
});

test("cleaning ready is single-language", () => {
  const base={propertyName:"Casa",roomName:"A",start:"10:00",end:"11:00"};
  const es=buildCleaningReadySmsBody({...base,language:"es"});
  const en=buildCleaningReadySmsBody({...base,language:"en"});
  assert.match(es,/limpieza lista/i); assert.match(es,/Unidad:/); assert.doesNotMatch(es,/cleaning ready|Unit:/i);
  assert.match(en,/cleaning ready/i); assert.match(en,/Unit:/); assert.doesNotMatch(en,/limpieza lista|Unidad:/i);
});

test("follow-up reminders are localized without changing intent", () => {
  const base={propertyName:"Casa",actionUrl:"https://api.example/c"};
  const es=buildCleanerFollowupSms({...base,kind:"START_REMINDER",language:"es"});
  const en=buildCleanerFollowupSms({...base,kind:"COMPLETION_REMINDER",language:"en"});
  assert.match(es,/no se ha marcado como iniciada/i); assert.doesNotMatch(es,/has not been marked started/i);
  assert.match(en,/not marked finished/i); assert.doesNotMatch(en,/no se ha marcado/i);
});

test("cleaning access lifecycle SMS is single-language", () => {
  const base={propertyName:"Casa",roomName:"A",startsAt:new Date("2026-10-03T15:10:00Z"),endsAt:new Date("2026-10-03T15:40:00Z"),timezone:"America/Puerto_Rico"};
  const startEs=buildCleaningStartSmsBody({...base,language:"es"});
  const endEn=buildCleaningEndSmsBody({propertyName:"Casa",roomName:"A",endsAt:base.endsAt,timezone:base.timezone,language:"en"});
  assert.match(startEs,/inicio de limpieza/i); assert.doesNotMatch(startEs,/cleaning start/i);
  assert.match(endEn,/cleaning done/i); assert.doesNotMatch(endEn,/limpieza terminada/i);
});

test("cleaner cancellation is single-language", () => {
  const base={reservationNumber:"PG-1",propertyName:"Casa",checkIn:new Date("2026-10-03T19:00:00Z"),checkOut:new Date("2026-10-04T15:00:00Z"),timeZone:"America/Puerto_Rico"};
  const es=buildManualCleanerCancellationSmsBody({...base,language:"es"});
  const en=buildManualCleanerCancellationSmsBody({...base,language:"en"});
  assert.match(es,/limpieza cancelada/i); assert.match(es,/No se requiere limpieza/i);
  assert.doesNotMatch(es,/cleaning cancelled|No cleaning required/i);
  assert.match(en,/cleaning cancelled/i); assert.match(en,/No cleaning required/i);
  assert.doesNotMatch(en,/limpieza cancelada|No se requiere limpieza/i);
});
