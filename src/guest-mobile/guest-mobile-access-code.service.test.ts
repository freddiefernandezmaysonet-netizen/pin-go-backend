import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { encryptAccessCode, hashAccessCode } from "../services/access-code-crypto.service.js";
import { readGuestMobileAccessCodes } from "./guest-mobile-access-code.service.js";

process.env.ACCESS_CODE_ENC_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
const now = new Date("2026-09-30T19:00:00Z");
const start = new Date("2026-09-30T18:00:00Z");
const end = new Date("2026-10-01T15:00:00Z");
function fixture() {
  const grant = {
    id: "grant", startsAt: start, endsAt: end, desiredStartsAt: start, desiredEndsAt: end,
    ttlockKeyboardPwdId: 42, unlockKey: "#",
    lock: { id: "door", displayName: "Front door", locationLabel: null, propertyId: "property", isActive: true, ttlockLockId: 123 },
    secureAccessCode: { accessGrantId: "grant", lockId: 123, keyboardPwdId: "42", method: "period",
      startDate: BigInt(+start), endDate: BigInt(+end), expiresAt: end,
      accessCodeEnc: encryptAccessCode("1234567"), accessCodeHash: hashAccessCode("1234567") },
  };
  const reservation = { status: "ACTIVE", checkOut: end, guestAccessReleaseStatus: "RELEASED",
    property: { id: "property", status: "ACTIVE", timezone: "America/Puerto_Rico" }, accessGrants: [grant] };
  const prisma = { guestStayLink: { findFirst: async (query: any) => {
    assert.deepEqual(query.where, { guestPersonId: "person", revokedAt: null, reservation: { reservationNumber: "PG-TEST" } });
    assert.deepEqual(query.select.reservation.select.accessGrants.where,
      { type: "GUEST", method: "PASSCODE_TIMEBOUND", status: "ACTIVE", startsAt: { lte: now }, endsAt: { gt: now } });
    return { reservation };
  } } } as unknown as PrismaClient;
  return { grant, reservation, prisma };
}
const input = { guestPersonId: "person", reservationNumber: "PG-TEST", now };
test("released current code and local validity are returned without internal identifiers", async () => {
  const { prisma } = fixture();
  assert.deepEqual(await readGuestMobileAccessCodes(prisma, input), { status: "AVAILABLE", codes: [{
    doorName: "Front door", code: "1234567", unlockKey: "#", startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: "America/Puerto_Rico",
  }] });
});
test("missing or revoked stay link does not authorize a code", async () => {
  const prisma = { guestStayLink: { findFirst: async () => null } } as unknown as PrismaClient;
  await assert.rejects(readGuestMobileAccessCodes(prisma, input), /STAY_NOT_AUTHORIZED/);
});
const blocked: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["cancelled stay", f => { f.reservation.status = "CANCELLED"; }],
  ["unreleased", f => { f.reservation.guestAccessReleaseStatus = "ELIGIBLE"; }],
  ["checkout boundary", f => { f.reservation.checkOut = now; }],
  ["inactive property", f => { f.reservation.property.status = "INACTIVE"; }],
  ["inactive lock", f => { f.grant.lock.isActive = false; }],
  ["different property", f => { f.grant.lock.propertyId = "other"; }],
  ["future grant", f => { f.grant.startsAt = end; }],
  ["expired grant", f => { f.grant.endsAt = now; }],
  ["expired encrypted code", f => { f.grant.secureAccessCode.expiresAt = now; }],
  ["different grant", f => { f.grant.secureAccessCode.accessGrantId = "other"; }],
  ["different lock", f => { f.grant.secureAccessCode.lockId = 456; }],
  ["different provider code", f => { f.grant.secureAccessCode.keyboardPwdId = "999"; }],
  ["inconsistent validity", f => { f.grant.secureAccessCode.endDate += 1000n; }],
  ["pending reconciliation", f => { f.grant.desiredEndsAt = now; }],
  ["missing encrypted value", f => { f.grant.secureAccessCode.accessCodeEnc = ""; }],
  ["ambiguous same-door grants", f => { f.reservation.accessGrants.push(f.grant); }],
];
for (const [name, mutate] of blocked) test(name, async () => {
  const f = fixture(); mutate(f);
  assert.deepEqual(await readGuestMobileAccessCodes(f.prisma, input), { status: "UNAVAILABLE", codes: [] });
});
test("corrupt encryption fails closed", async () => {
  const f = fixture(); f.grant.secureAccessCode.accessCodeEnc = "invalid";
  await assert.rejects(readGuestMobileAccessCodes(f.prisma, input));
});
test("hash mismatch fails closed", async () => {
  const f = fixture(); f.grant.secureAccessCode.accessCodeHash = "wrong";
  await assert.rejects(readGuestMobileAccessCodes(f.prisma, input), /ACCESS_CODE_UNAVAILABLE/);
});
