import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { captureVerifiedDeliveryReceipt as capture } from "./message-delivery-receipt-capture.service";

test("PostgreSQL capture survives reconnect, deduplicates by account and rejects conflicting events", async t => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/pin_go_message_delivery_outcomes");
  const db = new PrismaClient();
  const key = "capture_test_" + randomUUID().replaceAll("-", "");
  const env = { MESSAGE_DELIVERY_RECEIPT_INBOX_MODE: "CAPTURE", MESSAGE_DELIVERY_RESEND_ACCOUNT_KEY: key };
  const eventAt = new Date("2026-11-22T16:00:00Z");
  const receipt = { provider: "resend" as const, providerMessageId: key,
    status: "DELIVERED" as const, eventAt, deliveredAt: eventAt };
  t.after(async () => {
    await db.messageDeliveryReceipt.deleteMany({ where: { accountKey: { in: [key, key + "_other"] } } });
    await db.$disconnect();
  });
  assert.deepEqual(await capture(db, receipt, {eventId: "event"}, {}), {retained: false});
  const results = await Promise.all(Array.from({length: 6}, () => capture(db, receipt, {eventId: "event"}, env)));
  assert.equal(new Set(results.map(r => r.receiptId)).size, 1);
  await db.$disconnect(); await db.$connect();
  assert.equal(await db.messageDeliveryReceipt.count({where: {accountKey: key}}), 1);
  const original = await db.messageDeliveryReceipt.findFirstOrThrow({where: {accountKey: key}});
  await assert.rejects(capture(db, {...receipt, status: "FAILED"}, {eventId: "event"}, env), /EVENT_CONFLICT/);
  assert.deepEqual(await db.messageDeliveryReceipt.findUnique({where: {id: original.id}}), original);
  await capture(db, receipt, {eventId: "event"}, {...env, MESSAGE_DELIVERY_RESEND_ACCOUNT_KEY: key + "_other"});
  assert.equal(await db.messageDeliveryReceipt.count({where: {providerMessageId: key}}), 2);
  assert.equal(await db.messageLog.count({where: {providerMessageId: key}}), 0,
    "capture must not fabricate a message, delivery, or resend intent");
});
