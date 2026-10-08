import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { isGuestOperationalSmsEligible } from "./guest-journey-access-communications-bridge.policy.ts";

// Execute the real worker function and SMS service with isolated persistence/providers.
// No production client, credentials or network are exposed to the VM.
function load(source, dependencies = {}, globals = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new vm.Script(compiled.outputText).runInNewContext({ module, exports: module.exports, Date, Intl, URL,
    process: { env: {} }, console: { log() {}, error() {} }, ...globals,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`); return dependencies[name]; },
  });
  return module.exports;
}
const worker = readFileSync(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");
const workerFunction = worker.slice(worker.indexOf("async function processPreCheckinMessages("), worker.indexOf("// Si quieres permitir activación"));
const serviceSource = readFileSync(new URL("./preCheckinSms.service.ts", import.meta.url), "utf8");
const noon = new Date("2026-10-08T16:00Z");
function reservation(id = "r", overrides = {}) {
  return { id, reservationNumber: "SYNTHETIC-65", guestName: "Synthetic", guestEmail: "guest@example.test", guestPhone: "+17875550100",
    source: "DIRECT_BOOKING", externalProvider: null, externalId: null, guestToken: null,
    preferredLanguage: "es", guestAgreementSnapshot: { requiresIdentityVerification: false }, verificationStatus: "NOT_REQUIRED",
    checkIn: new Date("2026-10-08T20:00Z"), checkOut: new Date("2026-10-10T15:00Z"), createdAt: new Date("2026-10-01T12:00Z"),
    status: "ACTIVE", paymentState: "PAID", cancelledAt: null,
    externalRaw: { consent: { smsConsent: true, stayNotificationsConsent: true, acceptedAt: "2026-10-08T16:15:54Z" } },
    property: { id: "p", organizationId: "o", name: "Casa", timezone: "America/Puerto_Rico" }, ...overrides };
}
function fixture(rows, options = {}) {
  const dispatch = rows.map(r => ({ reservationId: r.id, type: "PRECHECKIN", channel: "email", status: "SENT" }));
  const messages = [], sms = [], emails = [], queries = [];
  function matches(row, where) {
    return Object.entries(where).every(([key, value]) => {
      if (key === "AND") return value.every(w => matches(row, w));
      if (key === "OR") return value.some(w => matches(row, w));
      if (key === "messageDispatchLogs") return !dispatch.some(log => log.reservationId === row.id && matches(log, value.none));
      if (value && typeof value === "object" && !(value instanceof Date)) return Object.entries(value).every(([op, expected]) => {
        if (op === "not") return row[key] !== expected;
        if (op === "gt") return row[key] > expected;
        if (op === "lte") return row[key] <= expected;
        throw Error(`Unexpected operator: ${op}`);
      });
      return row[key] === value;
    });
  }
  const db = {
    reservation: {
      findMany: async args => { queries.push(args); return rows.filter(r => matches(r, args.where) && (!args.cursor || r.id > args.cursor.id)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, args.take); },
      findUnique: async ({ where }) => rows.find(r => r.id === where.id),
    },
    messageDispatchLog: { findFirst: async ({ where }) => dispatch.find(log => matches(log, where)), create: async ({ data }) => { dispatch.push(data); return data; } },
    messageLog: { create: async ({ data }) => { messages.push(data); return data; } },
  };
  const service = load(serviceSource, {
    "./property-arrival-location.js": { formatPropertyArrivalLocation: () => null },
    "./guest-registration-channel.policy": { isChannexGuestRegistrationExempt: r => r.externalProvider === "CHANNEX" && Boolean(r.externalId) },
    "../channex-messaging/ota-operational-guest.service.js": { deliverOtaOperationalCommunication: async () => options.otaResult ?? null },
    "./ota-guest-external-messaging.policy.js": { isOtaGuestExternalDeliveryBlocked: () => Boolean(options.blockExternal) },
    "./guest-journey-access-communications-bridge.policy.js": { isGuestOperationalSmsEligible },
    "@prisma/client": {}, "../integrations/twilio/twilio.client": { sendSms: async (to, body) => { sms.push({ to, body }); return { sid: "synthetic-sid" }; } },
    "./guest-language.service": { resolveGuestLanguage: () => "es", getGuestIntlLocale: () => "es-PR" },
    "./email-delivery.service": { sendLoggedEmail: async () => { emails.push(true); return { status: "SENT" }; } },
    "./organization-guest-email.service": {}, "../lib/mailer": {},
  });
  const run = load(workerFunction + "\nexports.run = processPreCheckinMessages;", {}, {
    prisma: db, PaymentState: { PAID: "PAID" }, ReservationStatus: { ACTIVE: "ACTIVE" },
    sendPreCheckinEmail: service.sendPreCheckinEmail, sendPreCheckinSms: service.sendPreCheckinSms,
    isGuestOperationalSmsEligible, log() {}, errLog() {},
  }).run;
  return { run, service, db, rows, dispatch, messages, sms, emails, queries };
}

test("noon email does not consume SMS when consent arrives at 12:15; later ticks send once", async () => {
  const r = reservation("r", { externalRaw: { consent: { smsConsent: false } } });
  const f = fixture([r]);
  await f.run(noon); assert.equal(f.sms.length, 0);
  r.externalRaw = reservation().externalRaw;
  await f.run(new Date("2026-10-08T16:16Z"));
  assert.equal(f.sms.length, 1); assert.equal(f.emails.length, 0);
  assert.equal(f.dispatch.filter(log => log.channel === "sms" && log.status === "SENT").length, 1);
  await f.run(new Date("2026-10-08T16:17Z")); assert.equal(f.sms.length, 1);
});
test("old reservation can catch up after check-in without a new pre-arrival email or today claim", async () => {
  const f = fixture([reservation()]);
  f.dispatch.length = 0;
  await f.run(new Date("2026-10-09T16:00Z"));
  assert.equal(f.sms.length, 1); assert.equal(f.emails.length, 0);
  assert.match(f.sms[0].body, /Informacion de llegada/);
  assert.doesNotMatch(f.sms[0].body, /Check-in hoy/);
});
test("an earlier SMS SENT prevents another send even when email evidence is absent", async () => {
  const f = fixture([reservation("r", { guestEmail: null })]);
  f.dispatch.splice(0, 1, { reservationId: "r", type: "PRECHECKIN", channel: "sms", status: "SENT" });
  await f.run(noon); assert.equal(f.sms.length, 0);
});
test("pending guests without consent in the first batch cannot starve a later consented guest", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => reservation(`a${String(i).padStart(3, "0")}`, { externalRaw: null }));
  rows.push(reservation("z"));
  const f = fixture(rows); await f.run(noon);
  assert.equal(f.queries.length, 2); assert.equal(f.sms.length, 1);
  assert.equal(f.dispatch.filter(log => log.channel === "sms")[0].reservationId, "z");
});
for (const [label, overrides, now] of [
  ["without consent", { externalRaw: null }, noon],
  ["before four-hour window", {}, new Date("2026-10-08T15:59Z")],
  ["at checkout", {}, new Date("2026-10-10T15:00Z")],
  ["cancelled", { status: "CANCELLED" }, noon],
  ["cancellation persisted", { cancelledAt: noon }, noon],
  ["unpaid", { paymentState: "PENDING" }, noon],
]) test(`worker and current SMS service reject ${label}`, async () => {
  const f = fixture([reservation("r", overrides)]);
  await f.run(now); await f.service.sendPreCheckinSms(f.db, "r", now);
  assert.equal(f.sms.length, 0); assert.equal(f.messages.length, 0);
});
test("OTA routing and external delivery blocks prevent Twilio fallback", async () => {
  for (const options of [{ otaResult: { ok: true, status: "SENT" } }, { otaResult: { ok: false, status: "FAILED" } }, { blockExternal: true }]) {
    const f = fixture([reservation("r", { externalProvider: "CHANNEX", externalId: "synthetic-booking" })], options);
    await f.run(noon); assert.equal(f.sms.length, 0); assert.equal(f.emails.length, 0);
  }
});
