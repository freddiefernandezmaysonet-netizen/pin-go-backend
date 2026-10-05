import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import type { Prisma } from "@prisma/client";

const databaseUrl = process.env.DEMO_NATIVE_TEST_DATABASE_URL;
const expectLegacyRejection = process.env.DEMO_NATIVE_EXPECT_LEGACY_REJECTION === "1";

test("native ingest connects to real secure pre-check-in on disposable PostgreSQL", {
  skip: !databaseUrl,
  timeout: 90_000,
}, async t => {
  // Check before importing services that instantiate their own Prisma clients.
  // This test must never read or repair the actual Demo Property in production.
  const parsed = new URL(databaseUrl!);
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.DATABASE_URL, databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_demo_precheckin_test");
  assert.equal(parsed.search, "");

  let externalRequests = 0;
  const rejectExternalRequest = () => {
    externalRequests++;
    throw new Error("DEMO_TEST_EXTERNAL_HTTP_FORBIDDEN");
  };
  const original = { fetch: globalThis.fetch, httpRequest: http.request,
    httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };
  globalThis.fetch = async () => rejectExternalRequest();
  http.request = rejectExternalRequest as typeof http.request;
  http.get = rejectExternalRequest as typeof http.get;
  https.request = rejectExternalRequest as typeof https.request;
  https.get = rejectExternalRequest as typeof https.get;
  t.after(() => {
    globalThis.fetch = original.fetch;
    http.request = original.httpRequest;
    http.get = original.httpGet;
    https.request = original.httpsRequest;
    https.get = original.httpsGet;
    assert.equal(externalRequests, 0, "ingest/pre-check-in must not call a real provider");
  });

  const { PrismaClient, Prisma } = await import("@prisma/client");
  const { ingestReservation } = await import("./ingest.service.js");
  const { completeInternalDemoSecurePrecheckin } = await import("./internal-demo-secure-precheckin.service.js");
  const { readCleanerAccessWindow } = await import("./cleaner-access-window.service.js");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  t.after(() => db.$disconnect());

  // Exact route allowlist ID, but in a fresh local CI database, not production.
  const propertyId = "cmomyua8b0001rv1dvl6xjr6g";
  assert.equal(await db.organization.count(), 0, "requires an empty disposable database");
  const org = await db.organization.create({ data: { name: "Synthetic native demo test" } });
  const property = await db.property.create({ data: {
    id: propertyId, organizationId: org.id, name: "Synthetic Demo Property",
    status: "ACTIVE", timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00",
    cleaningNfcEnabled: true, cleaningStartOffsetMinutes: 15, cleaningDurationMinutes: 240,
    guestAccessMode: "PASSCODE_PLUS_NFC", distributionEnabled: true, distributionStatus: "ACTIVE",
  } });
  const otherProperty = await db.property.create({ data: {
    organizationId: org.id, name: "Synthetic ordinary property", status: "ACTIVE",
  } });
  await db.lock.create({ data: { propertyId, ttlockLockId: 123456, isActive: true } });
  const staff = await db.staffMember.create({ data: {
    organizationId: org.id, fullName: "Synthetic cleaner", isActive: true,
    // Staff selection requires a phone. This fixture has no real recipient;
    // every outgoing HTTP call remains forbidden above.
    phoneE164: "+12025550123",
  } });
  await db.propertyStaff.create({ data: {
    propertyId, staffMemberId: staff.id, role: "PRIMARY", isActive: true,
    cleaningDurationCommitmentMinutes: 180,
  } });
  await db.propertyGuestAgreement.create({ data: {
    propertyId, version: "1", title: "Synthetic agreement", agreementText: "Synthetic test terms only.",
    isActive: true, requiresIdentityVerification: true, requiresAgreementSignature: true,
  } });

  // A one-hour stay after standard check-in, in the property's local evening.
  const checkIn = new Date();
  checkIn.setUTCDate(checkIn.getUTCDate() + 2);
  checkIn.setUTCHours(2, 0, 0, 0);
  const checkOut = new Date(checkIn.getTime() + 60 * 60_000);
  const metadata = { demo: true, paymentSimulated: true, created_by: "synthetic-platform@example.invalid",
    consent: { stayNotificationsConsent: false, smsConsent: false, consentSource: "INTERNAL_DEMO_CENTER",
      consentVersion: "stay_notifications_v1", acceptedAt: null } };
  // These are the server-owned identity/metadata values in admin.demo.routes.ts.
  const result = await ingestReservation({
    source: "INTERNAL_DEMO_DIRECT_BOOKING", externalProvider: "PIN_GO_INTERNAL_DEMO",
    externalId: "DEMO-native-integration-1", externalRaw: metadata,
    externalUpdatedAt: new Date().toISOString(), propertyId,
    guestName: "Synthetic demo guest", guestEmail: "guest@example.invalid", guestPhone: null,
    preferredLanguage: "es", adults: 1, children: 0, roomName: property.name,
    checkIn: checkIn.toISOString(), checkOut: checkOut.toISOString(),
    status: "ACTIVE", paymentState: "PAID", totalAmount: 0, currency: "usd",
  });
  const reservationId = result.reservationId;
  const stored = () => db.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  const before = await stored();
  const actor = { userId: "synthetic-platform-user", organizationId: org.id,
    email: "synthetic-platform@example.invalid", role: "PLATFORM_ADMIN" };
  const complete = (actorOverride = actor) => completeInternalDemoSecurePrecheckin(db, {
    reservationId, actor: actorOverride, delivery: { preferredLanguage: "es", smsConsent: false },
  });

  await t.test("native ingest persists identity, PG number, token and pending cleaning before pre-check-in", async () => {
    assert.equal(before.source, "INTERNAL_DEMO_DIRECT_BOOKING");
    assert.equal(before.externalProvider, "PIN_GO_INTERNAL_DEMO");
    assert.match(before.reservationNumber!, /^PG-\d{4}-\d{6,}$/);
    assert.equal(result.reservationNumber, before.reservationNumber);
    assert.ok(before.guestToken);
    assert.equal(result.guestToken, before.guestToken);
    assert.deepEqual(before.externalRaw, metadata);
    assert.equal(before.guestAgreementSignedAt, null);
    assert.equal(await db.webhookEventIngest.count(), 0);
    assert.equal(await db.cleaningConfirmation.count({ where: { reservationId, staffMemberId: staff.id, status: "PENDING" } }), 1);
  });

  if (expectLegacyRejection) {
    await t.test("pre-fix service reproduces INTERNAL_DEMO_RESERVATION_REQUIRED on that same persisted native reservation", async () => {
      await assert.rejects(complete(), /INTERNAL_DEMO_RESERVATION_REQUIRED/);
      assert.deepEqual(await stored(), before);
      assert.equal(await db.apmsAuditEntry.count({ where: {
        decisionId: `internal-demo-secure-precheckin:${reservationId}`,
      } }), 0);
    });
    return;
  }

  async function rejectsWithoutWrites(pattern: RegExp, override = actor) {
    const snapshot = await stored();
    const auditCount = await db.apmsAuditEntry.count();
    const journey = await db.guestJourney.findUnique({ where: { reservationId } });
    const grants = await db.accessGrant.findMany({ where: { reservationId }, orderBy: { id: "asc" } });
    const nfc = await db.nfcAssignment.findMany({ where: { reservationId }, orderBy: { id: "asc" } });
    await assert.rejects(complete(override), pattern);
    assert.deepEqual(await stored(), snapshot);
    assert.equal(await db.apmsAuditEntry.count(), auditCount);
    assert.deepEqual(await db.guestJourney.findUnique({ where: { reservationId } }), journey);
    assert.deepEqual(await db.accessGrant.findMany({ where: { reservationId }, orderBy: { id: "asc" } }), grants);
    assert.deepEqual(await db.nfcAssignment.findMany({ where: { reservationId }, orderBy: { id: "asc" } }), nfc);
  }
  await t.test("wrong role and wrong organization cannot simulate verification", async () => {
    await rejectsWithoutWrites(/INTERNAL_DEMO_PLATFORM_ADMIN_REQUIRED/, { ...actor, role: "ORG_ADMIN" });
    await rejectsWithoutWrites(/INTERNAL_DEMO_ORGANIZATION_MISMATCH/, { ...actor, organizationId: "other-org" });
  });
  const cases: Array<[string, Prisma.ReservationUpdateInput, RegExp]> = [
    ["real Direct Booking", { source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT" }, /INTERNAL_DEMO_RESERVATION_REQUIRED/],
    ["legacy Lodgify", { source: "LODGIFY", externalProvider: "LODGIFY" }, /INTERNAL_DEMO_RESERVATION_REQUIRED/],
    ["native label with Channex provider", { externalProvider: "CHANNEX" }, /INTERNAL_DEMO_RESERVATION_REQUIRED/],
    ["missing simulation evidence", { externalRaw: Prisma.DbNull }, /INTERNAL_DEMO_RESERVATION_REQUIRED/],
    ["false payment simulation", { externalRaw: { demo: true, paymentSimulated: false } }, /INTERNAL_DEMO_RESERVATION_REQUIRED/],
    ["different property in same organization", { property: { connect: { id: otherProperty.id } } }, /INTERNAL_DEMO_PROPERTY_REQUIRED/],
  ];
  for (const [label, patch, code] of cases) await t.test(`${label} is rejected without evidence or access writes`, async () => {
    await db.reservation.update({ where: { id: reservationId }, data: patch });
    try { await rejectsWithoutWrites(code); }
    finally { await db.reservation.update({ where: { id: reservationId }, data: {
      source: before.source, externalProvider: before.externalProvider,
      externalRaw: metadata, propertyId,
    } }); }
  });
  await t.test("inactive dedicated property is rejected without writes", async () => {
    await db.property.update({ where: { id: propertyId }, data: { status: "INACTIVE" } });
    try { await rejectsWithoutWrites(/INTERNAL_DEMO_PROPERTY_REQUIRED/); }
    finally { await db.property.update({ where: { id: propertyId }, data: { status: "ACTIVE" } }); }
  });
  await t.test("a readiness failure rolls back all simulated evidence", async () => {
    await db.reservation.update({ where: { id: reservationId }, data: { paymentState: "NONE" } });
    try { await rejectsWithoutWrites(/INTERNAL_DEMO_ACCESS_NOT_READY:PAYMENT_NOT_PAID/); }
    finally { await db.reservation.update({ where: { id: reservationId }, data: { paymentState: "PAID" } }); }
  });
  await t.test("that same native reservation completes through the real agreement, journey, readiness and audit services", async () => {
    const completed = await complete();
    assert.equal(completed.simulated, true);
    assert.equal(completed.readiness.ready, true);
    assert.deepEqual(completed.readiness.blockers, []);
    assert.equal(completed.readiness.releaseStatus, "ELIGIBLE");
    assert.equal(completed.guestJourney.currentState, "VERIFICATION_COMPLETED");
    const after = await stored();
    assert.equal(after.source, before.source);
    assert.equal(after.externalProvider, before.externalProvider);
    assert.equal(after.reservationNumber, before.reservationNumber);
    assert.equal(after.guestToken, before.guestToken);
    assert.equal(after.checkIn.getTime(), checkIn.getTime());
    assert.equal(after.checkOut.getTime(), checkOut.getTime());
    assert.equal(after.verificationStatus, "COMPLETED");
    assert.equal(after.preferredLanguage, "es");
    assert.equal(after.guestAccessReleaseStatus, "ELIGIBLE");
    assert.equal(after.guestAccessModeSnapshot, "PASSCODE_PLUS_NFC");
    assert.ok(after.guestAgreementSignedAt);
    const acceptance = after.guestAgreementAcceptance as Record<string, unknown>;
    assert.equal(acceptance.simulated, true);
    assert.equal(acceptance.demoOnly, true);
    assert.equal(acceptance.source, "INTERNAL_DEMO_CENTER");
    const raw = after.externalRaw as Record<string, unknown>;
    assert.equal(raw.demo, true);
    assert.equal(raw.paymentSimulated, true);
    assert.equal(await db.apmsAuditEntry.count({ where: {
      decisionId: `internal-demo-secure-precheckin:${reservationId}`,
    } }), 1);
    for (const key of ["stripeCheckoutSessionId", "stripePaymentIntentId", "stripeChargeId",
      "stripeConnectedAccountId", "stripeTransferId", "stripeApplicationFeeId"] as const) {
      assert.equal(after[key], null);
    }
    assert.equal(after.amountCollected.toString(), "0");
    assert.equal(after.amountRefunded.toString(), "0");
    const grants = await db.accessGrant.findMany({ where: { reservationId } });
    assert.equal(grants.length, 1);
    assert.equal(grants[0]!.status, "PENDING");
    assert.equal(grants[0]!.startsAt.getTime(), checkIn.getTime());
    assert.equal(grants[0]!.endsAt.getTime(), checkOut.getTime());
    assert.equal(grants[0]!.ttlockKeyboardPwdId, null);
    const window = await readCleanerAccessWindow(db, { ...after, property });
    assert.equal(window.durationMinutes, 30);
    assert.equal(window.startsAt.getTime(), checkOut.getTime() + 15 * 60_000);
    assert.equal(window.endsAt.getTime(), checkOut.getTime() + 45 * 60_000);
    const savedProperty = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
    assert.equal(savedProperty.cleaningDurationMinutes, 240);
    assert.equal(savedProperty.cleaningStartOffsetMinutes, 15);
    assert.equal(externalRequests, 0);
  });
});
