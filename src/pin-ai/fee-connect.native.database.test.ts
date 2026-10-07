import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { recordPinAIReservationFee } from "./reservation-fee.service.js";
import { collectPinAIConnectFee, type ConnectDebitPayment, type ConnectDebitProvider } from "./fee-connect.service.js";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";

const enabled = process.env.PIN_AI_NATIVE_DB_TEST === "true";
const url = new URL(process.env.DATABASE_URL ?? "http://missing");
if (enabled && (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/pin_ai_activation_test"))
  throw Error("Native concurrency tests require isolated localhost pin_ai_activation_test database");

test("native PostgreSQL: concurrent accrual/collection and expired-response recovery", { skip: !enabled }, async () => {
  const db = new PrismaClient(), second = new PrismaClient();
  const versions = await db.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
  assert.match(versions[0].version, /PostgreSQL/);
  assert.doesNotMatch(versions[0].version, /pglite|wasm|emscripten/i);
  const now = new Date();
  const org = await db.organization.create({ data: { name: "Synthetic native concurrency", pinAIEnabled: true,
    pinAIRevision: 1, stripeConnectAccountId: "acct_native_synthetic" } });
  const p = await db.property.create({ data: { name: "Synthetic native concurrency", organizationId: org.id,
    pinAIEnabled: true, pinAIRevision: 1, pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
    pinAITermsAcceptedAt: new Date(+now - 1000), pinAITermsAcceptedBy: "synthetic-host" } });
  const r = await db.reservation.create({ data: { propertyId: p.id, guestName: "Synthetic concurrent",
    source: "MANUAL", checkIn: new Date(+now + 3600000), checkOut: new Date(+now + 86400000) } });
  const env = { PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
    PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: org.id };
  const scope = { reservationId: r.id, propertyId: p.id, organizationId: org.id };
  try {
    const accrual = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      recordPinAIReservationFee(i % 2 ? db : second, env, scope, now)));
    for (const result of accrual) {
      if (result.status === "rejected") assert.equal(result.reason.code, "P2034", "only serializable conflicts may be retried");
    }
    assert.ok(accrual.some(v => v.status === "fulfilled" && v.value === "RECORDED"));
    assert.equal(await db.pinAIReservationFee.count({ where: { reservationId: r.id } }), 1);
    let creates = 0;
    const original: ConnectDebitPayment = { id: `py_native_${r.id}`, accountId: "acct_native_synthetic",
      amount: 100, currency: "usd", paid: true, status: "succeeded", metadata: { pinAIReservationId: r.id,
        organizationId: org.id, propertyId: p.id, pinAITermsVersion: PIN_AI_BILLING_TERMS.version } };
    const provider: ConnectDebitProvider = { eligibility: async () => ({ compatible: true, availableCents: 100 }),
      create: async () => { creates++; throw Error("synthetic lost response after debit"); },
      retrieve: async () => original, reconcile: async () => ({ complete: true, payments: [original] }) };
    const collection = await Promise.all([collectPinAIConnectFee(db, provider, env, r.id, now),
      collectPinAIConnectFee(second, provider, env, r.id, now)]);
    assert.equal(creates, 1);
    assert.ok(collection.includes("RETRY_PENDING"));
    assert.ok(collection.some(v => ["BUSY", "NOT_DUE"].includes(v)));
    assert.equal(await collectPinAIConnectFee(second, provider, env, r.id, new Date(+now + 48 * 3600000)), "PAID");
    assert.equal(creates, 1);
    const saved = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId: r.id } });
    assert.equal(saved.stripeDebitPaymentId, original.id);
  } finally {
    await db.pinAIReservationFee.deleteMany({ where: { organizationId: org.id } });
    await db.reservation.delete({ where: { id: r.id } });
    await db.property.delete({ where: { id: p.id } });
    await db.organization.delete({ where: { id: org.id } });
    await second.$disconnect(); await db.$disconnect();
  }
});
