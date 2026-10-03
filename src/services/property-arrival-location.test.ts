import assert from "node:assert/strict";
import test from "node:test";
import { parsePropertyArrivalLocation, formatPropertyArrivalLocation } from "./property-arrival-location.js";
import { buildGuestPasscodeSmsBody } from "./messaging.service.js";
import { buildPreCheckinMessage } from "./preCheckinSms.service.js";
import { buildAirbnbAccessText } from "../channex-messaging/airbnb-access.policy.js";
import { buildGuestAccessSmsRetryBody } from "./guest-access-sms-retry-body.service.js";

const property = { complexName: "Las Palmas Doradas", unitNumber: "107B" };
const arrivalLocation = formatPropertyArrivalLocation(property, "es");
const checkIn = new Date("2026-10-03T19:00:00Z"), checkOut = new Date("2026-10-04T15:00:00Z");
test("optional fields preserve letters, leading zeros, clears and partial edits", () => {
  assert.deepEqual(parsePropertyArrivalLocation({ complexName: " Las Palmas Doradas ", unitNumber: " 107B " }), property);
  assert.deepEqual(parsePropertyArrivalLocation({ unitNumber: "007B" }), { unitNumber: "007B" });
  assert.deepEqual(parsePropertyArrivalLocation({ complexName: " " }), { complexName: null });
  assert.deepEqual(parsePropertyArrivalLocation({ unitNumber: null }), { unitNumber: null });
  assert.deepEqual(parsePropertyArrivalLocation({}), {});
});
test("malformed arrival details are rejected without coercion or truncation", () => {
  for (const value of [107, {}, [], "a".repeat(33), "107\nB"]) assert.throws(() => parsePropertyArrivalLocation({ unitNumber: value }));
  assert.throws(() => parsePropertyArrivalLocation({ complexName: "x".repeat(121) }));
});
test("location is optional and localized without inventing building or unit", () => {
  assert.equal(arrivalLocation, "Las Palmas Doradas · Unidad 107B");
  assert.equal(formatPropertyArrivalLocation(property, "en"), "Las Palmas Doradas · Unit 107B");
  assert.equal(formatPropertyArrivalLocation({}, "es"), "");
  assert.equal(formatPropertyArrivalLocation({ unitNumber: "107B" }, "es"), "Unidad 107B");
});
test("arrival and access templates preserve the complete unit separately from truncated property names", () => {
  const pre = buildPreCheckinMessage({ propertyName: "A very long name ".repeat(12), checkInTime: "3:00 PM", address: null, mapsLink: null, verifyLink: null, language: "es", arrivalLocation });
  const sms = buildGuestPasscodeSmsBody({ code: "123456", validUntil: checkOut, timezone: "America/Puerto_Rico", language: "es", arrivalLocation });
  const ota = buildAirbnbAccessText({ type: "GUEST_ACCESS_PASSCODE", propertyName: "Serena Studio", language: "es", timezone: "America/Puerto_Rico", checkIn, checkOut, code: "123456", arrivalLocation });
  for (const text of [pre, sms, ota]) assert.ok(text.includes(arrivalLocation));
});
test("access SMS retry reloads current unit and encrypted credential, rejects stale or wrong recipients", async () => {
  const grant: any = { type: "GUEST", method: "PASSCODE_TIMEBOUND", status: "ACTIVE", lastAppliedAt: checkIn, startsAt: checkIn, endsAt: checkOut,
    secureAccessCode: { accessCodeEnc: "encrypted" }, reservation: { status: "ACTIVE", cancelledAt: null, guestAccessReleaseStatus: "RELEASED", guestAccessReleasedAt: checkIn,
      checkIn, checkOut, guestPhone: "+17875550100", preferredLanguage: "es", property: { ...property, timezone: "America/Puerto_Rico" } } };
  const prisma: any = { accessGrant: { findFirst: async () => grant } };
  const msg = { communicationType: "GUEST_ACCESS_PASSCODE", body: "Old masked code ****", accessGrantId: "grant", reservationId: "res", propertyId: "prop", organizationId: "org", to: "+17875550100" };
  const options = { now: checkIn, decrypt: () => "123456" };
  const body = await buildGuestAccessSmsRetryBody(prisma, msg, options);
  assert.ok(body.includes(arrivalLocation)); assert.match(body, /123456/); assert.doesNotMatch(body, /encrypted|\*\*\*\*/);
  await assert.rejects(buildGuestAccessSmsRetryBody(prisma, { ...msg, to: "+17875550199" }, options));
  grant.status = "REVOKED";
  await assert.rejects(buildGuestAccessSmsRetryBody(prisma, msg, options));
  assert.equal(await buildGuestAccessSmsRetryBody(prisma, { ...msg, communicationType: "CLEANING_START" }, options), msg.body);
});
