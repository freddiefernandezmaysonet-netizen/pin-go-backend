import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { readGuestMobileAccessCodes } from "./guest-mobile-access-code.service.js";
import { resolveGuestMobileSession } from "./guest-mobile-session.service.js";
import { encryptAccessCode, hashAccessCode } from "../services/access-code-crypto.service.js";

const TEST_URL = "postgresql://guest_mobile_ci:guest_mobile_ci@127.0.0.1:5432/guest_mobile_ci";

test("access codes with disposable PostgreSQL and real Prisma relations", async t => {
  assert.equal(process.env.GUEST_MOBILE_DB_TEST, "true");
  assert.equal(process.env.DATABASE_URL, TEST_URL, "Refusing any non-test database");
  process.env.ACCESS_CODE_ENC_KEY_BASE64 = Buffer.alloc(32, 9).toString("base64");
  const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  t.after(() => db.$disconnect());
  assert.equal(await db.organization.count(), 0, "Requires an empty disposable database; never reset existing data");
  await db.$queryRaw`SELECT 1`;
  const now = new Date();
  const start = new Date(+now - 60_000);
  const end = new Date(+now + 3_600_000);
  const organization = await db.organization.create({ data: { name: "Synthetic mobile test" } });
  const property = await db.property.create({ data: { name: "Synthetic property", organizationId: organization.id, timezone: "America/Puerto_Rico" } });
  const lock = await db.lock.create({ data: { propertyId: property.id, ttlockLockId: 900001, displayName: "Synthetic door" } });
  const reservation = await db.reservation.create({ data: {
    propertyId: property.id, reservationNumber: "PG-LOCAL-TEST", guestName: "Synthetic guest",
    checkIn: start, checkOut: end, status: "ACTIVE", guestAccessReleaseStatus: "RELEASED",
  } });
  const person = await db.guestPerson.create({ data: { displayName: "Synthetic guest" } });
  const link = await db.guestStayLink.create({ data: { guestPersonId: person.id, reservationId: reservation.id } });
  const bearer = "synthetic_mobile_session_token_0001";
  const session = await db.guestDeviceSession.create({ data: {
    guestPersonId: person.id, tokenHash: createHash("sha256").update(bearer).digest("hex"), expiresAt: end,
  } });
  const grant = await db.accessGrant.create({ data: {
    lockId: lock.id, reservationId: reservation.id, type: "GUEST", method: "PASSCODE_TIMEBOUND",
    status: "ACTIVE", startsAt: start, endsAt: end, ttlockKeyboardPwdId: 42,
    secureAccessCode: { create: { lockId: lock.ttlockLockId, method: "period", keyboardPwdId: "42",
      startDate: BigInt(+start), endDate: BigInt(+end), expiresAt: end,
      accessCodeEnc: encryptAccessCode("1234567"), accessCodeHash: hashAccessCode("1234567"), accessCodeMasked: "***4567" } },
  } });
  const input = { guestPersonId: person.id, reservationNumber: reservation.reservationNumber!, now };
  const read = () => readGuestMobileAccessCodes(db, input);
  const hidden = async () => assert.deepEqual(await read(), { status: "UNAVAILABLE", codes: [] });

  await t.test("valid session and encrypted code survive database roundtrip", async () => {
    assert.equal((await resolveGuestMobileSession(db, bearer, now)).guestPersonId, person.id);
    assert.deepEqual(await read(), { status: "AVAILABLE", codes: [{ doorName: "Synthetic door", code: "1234567", unlockKey: "#",
      startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: "America/Puerto_Rico" }] });
  });
  await t.test("another guest cannot use the reservation link", async () => {
    const other = await db.guestPerson.create({ data: { displayName: "Other synthetic guest" } });
    await assert.rejects(readGuestMobileAccessCodes(db, { ...input, guestPersonId: other.id }), /STAY_NOT_AUTHORIZED/);
  });
  await t.test("revoked link blocks disclosure", async () => {
    await db.guestStayLink.update({ where: { id: link.id }, data: { revokedAt: now } });
    await assert.rejects(read(), /STAY_NOT_AUTHORIZED/);
    await db.guestStayLink.update({ where: { id: link.id }, data: { revokedAt: null } });
  });
  await t.test("Prisma filters pending and revoked grants", async () => {
    for (const status of ["PENDING", "REVOKED"] as const) {
      await db.accessGrant.update({ where: { id: grant.id }, data: { status } });
      await hidden();
    }
    await db.accessGrant.update({ where: { id: grant.id }, data: { status: "ACTIVE" } });
  });
  await t.test("Prisma filters staff grants and future windows", async () => {
    await db.accessGrant.update({ where: { id: grant.id }, data: { type: "STAFF" } });
    await hidden();
    await db.accessGrant.update({ where: { id: grant.id }, data: { type: "GUEST", startsAt: end } });
    await hidden();
    await db.accessGrant.update({ where: { id: grant.id }, data: { startsAt: start } });
  });
  await t.test("unreleased and cancelled stays hide codes", async () => {
    await db.reservation.update({ where: { id: reservation.id }, data: { guestAccessReleaseStatus: "BLOCKED" } });
    await hidden();
    await db.reservation.update({ where: { id: reservation.id }, data: { guestAccessReleaseStatus: "RELEASED", status: "CANCELLED" } });
    await hidden();
    await db.reservation.update({ where: { id: reservation.id }, data: { status: "ACTIVE" } });
  });
  await t.test("checkout boundary hides code", async () => {
    await db.reservation.update({ where: { id: reservation.id }, data: { checkOut: now } });
    await hidden();
    await db.reservation.update({ where: { id: reservation.id }, data: { checkOut: end } });
  });
  await t.test("pending validity reconciliation hides code", async () => {
    await db.accessGrant.update({ where: { id: grant.id }, data: { desiredEndsAt: new Date(+end + 60_000) } });
    await hidden();
    await db.accessGrant.update({ where: { id: grant.id }, data: { desiredEndsAt: null } });
  });
  await t.test("corrupt persisted encryption fails closed", async () => {
    await db.accessCode.update({ where: { accessGrantId: grant.id }, data: { accessCodeEnc: "invalid" } });
    await assert.rejects(read());
  });
  await t.test("revoked and expired sessions are rejected", async () => {
    await db.guestDeviceSession.update({ where: { id: session.id }, data: { revokedAt: now } });
    await assert.rejects(resolveGuestMobileSession(db, bearer, now), /UNAUTHENTICATED/);
    await db.guestDeviceSession.update({ where: { id: session.id }, data: { revokedAt: null, expiresAt: now } });
    await assert.rejects(resolveGuestMobileSession(db, bearer, now), /UNAUTHENTICATED/);
  });
  assert.equal(await db.messageLog.count(), 0);
});
