import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { enrollPinAIService, accrueEnrolledPinAIFee } from "./service-enrollment.service.js";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";
import { collectPinAIConnectFee } from "./fee-connect.service.js";
import { capturePinAIReservationService } from "./reservation-service-evidence.js";
import { runPinAIConnectBillingCycle } from "./fee-connect-cycle.service.js";

const enabled = process.env.PIN_AI_ACTIVATION_DB_TEST === "true";
const url = new URL(process.env.DATABASE_URL ?? "http://missing");
if (enabled && (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/pin_ai_activation_test"))
  throw new Error("Enrollment tests require isolated local database");

test("persisted service enrollment: cancellation timing, whole-window outage and historical evidence", { skip: !enabled }, async t => {
  const db = new PrismaClient();
  const enrolledAt = new Date("2030-01-01T12:00:00Z"), opensAt = new Date(+enrolledAt + 86400000);
  const checkIn = new Date(+opensAt + 86400000), checkOut = new Date(+checkIn + 86400000);
  const org = await db.organization.create({ data: { name: "Synthetic enrollment", pinAIEnabled: true,
    pinAIRevision: 1, stripeConnectAccountId: "acct_enrollment" } });
  const p = await db.property.create({ data: { name: "Synthetic enrollment", organizationId: org.id,
    pinAIEnabled: true, pinAIRevision: 1, pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
    pinAITermsAcceptedAt: new Date(+enrolledAt - 1000), pinAITermsAcceptedBy: "synthetic-host" } });
  const env = { PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
    PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: org.id };
  const scope = (id: string) => ({ reservationId: id, propertyId: p.id, organizationId: org.id });
  const create = (source = "MANUAL") => db.reservation.create({ data: { propertyId: p.id, guestName: "Synthetic",
    checkIn, checkOut, source, guestToken: randomUUID() } });
  try {
    await t.test("future enrollment is not a fee; early cancellation is excluded including exact opening", async () => {
      for (const offset of [-1, 0]) {
        const r = await create();
        assert.equal(await enrollPinAIService(db, env, scope(r.id), enrolledAt), "ENROLLED");
        assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: r.id } }), 0);
        assert.equal(await accrueEnrolledPinAIFee(db, env, r.id, new Date(+opensAt - 1)), "NOT_DUE");
        await db.reservation.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelledAt: new Date(+opensAt + offset) } });
        assert.equal(await accrueEnrolledPinAIFee(db, env, r.id, new Date(+checkOut + 5 * 86400000)), "EXCLUDED");
        assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: r.id } }), 0);
      }
    });
    await t.test("late cancellation before first fee scan recovers one obligation after entire window", async () => {
      const r = await create("Airbnb");
      assert.equal(await enrollPinAIService(db, env, scope(r.id), enrolledAt), "ENROLLED");
      assert.equal(await enrollPinAIService(db, env, scope(r.id), enrolledAt), "ALREADY_ENROLLED");
      await db.reservation.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelledAt: new Date(+opensAt + 1) } });
      const resumedAt = new Date(+checkOut + 5 * 86400000);
      assert.equal(await accrueEnrolledPinAIFee(db, env, r.id, resumedAt), "RECORDED");
      assert.equal(await accrueEnrolledPinAIFee(db, env, r.id, resumedAt), "ACCRUED");
      const fee = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: r.id } });
      assert.equal(+fee.serviceStartedAt, +opensAt);
      assert.equal(fee.amountCents, 100); assert.equal(fee.billingStatus, "PENDING_CONNECT");
    });
    await t.test("worker enrolls without chat and recovers active reservation after whole-window outage", async () => {
      const r = await create();
      let debits = 0;
      const provider = { eligibility: async () => ({ compatible: true, availableCents: 100 }),
        create: async (fee: any) => { debits++; return { id: `py_${fee.reservationId}`, accountId: "acct_enrollment",
          amount: 100, currency: "usd", paid: true, status: "succeeded", metadata: { pinAIReservationId: fee.reservationId,
            organizationId: org.id, propertyId: p.id, pinAITermsVersion: PIN_AI_BILLING_TERMS.version } }; },
        retrieve: async () => { throw Error("unexpected"); } };
      const scheduled = await runPinAIConnectBillingCycle(db, provider, env, enrolledAt);
      assert.ok(scheduled.enrolled >= 1); assert.equal(debits, 0, "no fee may be debited before its evidenced opening");
      assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: r.id } }), 0);
      const resumed = await runPinAIConnectBillingCycle(db, provider, env, new Date(+checkOut + 5 * 86400000));
      assert.equal(resumed.recorded, 1);
      assert.equal((await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: r.id } })).billingStatus, "PAID");
      assert.equal(debits, 2);
      await runPinAIConnectBillingCycle(db, provider, env, new Date(+checkOut + 6 * 86400000));
      assert.equal(debits, 2);
    });
    await t.test("missing cancellation timestamp and changed stay dates require review", async () => {
      for (const kind of ["missing-cancel-time", "dates-changed"] as const) {
        const r = await create(); await enrollPinAIService(db, env, scope(r.id), enrolledAt);
        await db.reservation.update({ where: { id: r.id }, data: kind === "dates-changed"
          ? { checkIn: new Date(+checkIn + 3600000) } : { status: "CANCELLED" } });
        assert.equal(await accrueEnrolledPinAIFee(db, env, r.id, opensAt), "NEEDS_REVIEW");
        assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: r.id } }), 0);
      }
    });
    await t.test("creation inside the window records each origin atomically without the worker", async () => {
      for (const source of ["DIRECT_BOOKING", "Airbnb", "VRBO", "MANUAL"]) {
        const inside = new Date(+opensAt + 3600000);
        const r = await db.$transaction(async tx => {
          const created = await tx.reservation.create({ data: { propertyId: p.id, guestName: "Synthetic immediate",
            source, externalProvider: ["Airbnb", "VRBO"].includes(source) ? "CHANNEX" : null, checkIn, checkOut } });
          assert.equal(await capturePinAIReservationService(tx, created.id, env, inside), "RECORDED");
          assert.equal(await capturePinAIReservationService(tx, created.id, env, inside), "ALREADY_RECORDED");
          await tx.reservation.update({ where: { id: created.id }, data: { status: "CANCELLED", cancelledAt: new Date(+inside + 1) } });
          return created;
        });
        const fee = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: r.id } });
        assert.equal(fee.amountCents, 100); assert.equal(fee.billingStatus, "PENDING_CONNECT");
      }
    });
    await t.test("evidence and reservation roll back together; initially cancelled OTA has no fee", async () => {
      let rolledBackId = "";
      await assert.rejects(db.$transaction(async tx => {
        const r = await tx.reservation.create({ data: { propertyId: p.id, guestName: "Synthetic rollback", checkIn, checkOut } });
        rolledBackId = r.id;
        assert.equal(await capturePinAIReservationService(tx, r.id, env, enrolledAt), "ENROLLED");
        throw Error("synthetic-reservation-write-failure");
      }), /synthetic-reservation-write-failure/);
      assert.equal(await db.reservation.count({ where: { id: rolledBackId } }), 0);
      assert.equal(await db.pinAIServiceEnrollment.count({ where: { reservationId: rolledBackId } }), 0);
      const r = await db.reservation.create({ data: { propertyId: p.id, guestName: "Already cancelled OTA",
        source: "Airbnb", externalProvider: "CHANNEX", status: "CANCELLED", checkIn, checkOut } });
      assert.equal(await db.$transaction(tx => capturePinAIReservationService(tx, r.id, env, opensAt)), "NOT_ELIGIBLE");
      assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: r.id } }), 0);
    });
    await t.test("cancellation transaction captures existing active service without a prior scan", async () => {
      const r = await create();
      const cancelledAt = new Date(+opensAt + 3600000);
      await db.$transaction(async tx => {
        assert.equal(await capturePinAIReservationService(tx, r.id, env, new Date(+cancelledAt - 1)), "RECORDED");
        await tx.reservation.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelledAt } });
      });
      assert.equal((await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: r.id } })).amountCents, 100);
    });
    await t.test("lost debit response after replay expiry reconciles persisted fee without a second create", async () => {
      const r = await create();
      const startedAt = new Date(+opensAt + 3600000);
      await db.$transaction(tx => capturePinAIReservationService(tx, r.id, env, startedAt));
      let creates = 0;
      const original = { id: `py_recovered_${r.id}`, accountId: "acct_enrollment", amount: 100,
        currency: "usd", paid: true, status: "succeeded", metadata: { pinAIReservationId: r.id,
          organizationId: org.id, propertyId: p.id, pinAITermsVersion: PIN_AI_BILLING_TERMS.version } };
      const provider = { eligibility: async () => ({ compatible: true, availableCents: 100 }),
        create: async () => { creates++; throw Error("original debit succeeded but response lost"); },
        retrieve: async () => original,
        reconcile: async () => ({ payments: [original], complete: true }) };
      assert.equal(await collectPinAIConnectFee(db, provider, env, r.id, startedAt), "RETRY_PENDING");
      assert.equal(await collectPinAIConnectFee(db, provider, env, r.id, new Date(+startedAt + 48 * 3600000)), "PAID");
      const saved = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: r.id } });
      assert.equal(saved.stripeDebitPaymentId, original.id);
      assert.equal(saved.billingStatus, "PAID"); assert.equal(creates, 1);
    });
    await t.test("activation change before opening requires review; later disable preserves obligation", async () => {
      const r = await create(); await enrollPinAIService(db, env, scope(r.id), enrolledAt);
      const event = await db.apmsAuditEntry.create({ data: { organizationId: org.id, propertyId: p.id,
        entityType: "PROPERTY", entityId: p.id, engine: "PIN_AI_ACTIVATION", eventType: "SET_ENABLED", status: "APPLIED",
        decisionId: randomUUID(), metadata: { enabled: false, revision: 2 }, createdAt: new Date(+opensAt - 1) } });
      await db.property.update({ where: { id: p.id }, data: { pinAIEnabled: false, pinAIRevision: 2 } });
      assert.equal(await accrueEnrolledPinAIFee(db, env, r.id, opensAt), "NEEDS_REVIEW");
      await db.property.update({ where: { id: p.id }, data: { pinAIEnabled: true, pinAIRevision: 1 } });
      await db.apmsAuditEntry.delete({ where: { id: event.id } });
      const later = await create(); await enrollPinAIService(db, env, scope(later.id), enrolledAt);
      await db.apmsAuditEntry.create({ data: { organizationId: org.id, propertyId: p.id,
        entityType: "PROPERTY", entityId: p.id, engine: "PIN_AI_ACTIVATION", eventType: "SET_ENABLED", status: "APPLIED",
        decisionId: randomUUID(), metadata: { enabled: false, revision: 2 }, createdAt: new Date(+opensAt + 1) } });
      await db.property.update({ where: { id: p.id }, data: { pinAIEnabled: false, pinAIRevision: 2 } });
      assert.equal(await accrueEnrolledPinAIFee(db, env, later.id, new Date(+checkOut + 5 * 86400000)), "RECORDED");
    });
    await t.test("no historical enrollment never fabricates retrospective service", async () => {
      const r = await create();
      assert.equal(await accrueEnrolledPinAIFee(db, env, r.id, new Date(+checkOut + 5 * 86400000)), "DISABLED");
      assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: r.id } }), 0);
    });
  } finally {
    await db.pinAIServiceEnrollment.deleteMany({ where: { organizationId: org.id } });
    await db.pinAIReservationFee.deleteMany({ where: { organizationId: org.id } });
    await db.apmsAuditEntry.deleteMany({ where: { organizationId: org.id } });
    await db.reservation.deleteMany({ where: { propertyId: p.id } });
    await db.property.delete({ where: { id: p.id } });
    await db.organization.delete({ where: { id: org.id } });
    await db.$disconnect();
  }
});
