import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { recoverDeliveryReceipts as recover } from "./message-delivery-receipt-recovery.service";

const enabled = {MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE: "APPLY"};
test("recovery is disabled before any database access and rejects invalid configuration", async () => {
  const db = new Proxy({}, {get() {throw Error("unexpected database access");}}) as PrismaClient;
  assert.equal((await recover(db, {})).processed, 0);
  assert.equal((await recover(db, {MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE: "OFF"})).processed, 0);
  await assert.rejects(recover(db, {MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE: "yes"}), /MODE_INVALID/);
});

test("PostgreSQL recovery commits evidence and acknowledgement together without resends", async t => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/pin_go_message_delivery_outcomes");
  const db = new PrismaClient();
  const key = "recovery_" + randomUUID();
  const org = await db.organization.create({data: {name: key}});
  t.after(async () => {
    await db.messageDeliveryReceipt.deleteMany({where: {providerMessageId: key}});
    await db.messageLog.deleteMany({where: {providerMessageId: key}});
    await db.property.deleteMany({where: {organizationId: org.id}});
    await db.organization.delete({where: {id: org.id}});
    await db.$disconnect();
  });
  const property = await db.property.create({data: {name: key, organizationId: org.id}});
  const eventAt = new Date("2026-11-23T12:00:00Z");
  const receipt = await db.messageDeliveryReceipt.create({data: {
    id: key, provider: "resend", accountKey: key, eventKey: key, fingerprint: key,
    providerMessageId: key, deliveryStatus: "DELIVERED", eventAt, deliveredAt: eventAt,
  }});
  // Receipt arrived before provider acknowledgement: preserve it for later.
  await recover(db, enabled);
  assert.equal((await db.messageDeliveryReceipt.findUniqueOrThrow({where: {id: key}})).lastOutcome, "UNBOUND_OR_UNKNOWN");
  const messageData = {provider: "resend", providerMessageId: key, providerAccountKey: key,
    organizationId: org.id, propertyId: property.id, channel: "email", to: "fixture@example.test",
    body: "fixture", status: "E7_SENDING"};
  const message = await db.messageLog.create({data: messageData});
  const other = await db.messageLog.create({data: {...messageData, providerAccountKey: key + "_other"}});
  const legacy = await db.messageLog.create({data: {...messageData, providerAccountKey: null}});
  const ready = () => db.messageDeliveryReceipt.update({where: {id: key}, data: {lastAttemptAt: null}});
  await ready();
  // Simulate a failure after the MessageLog write, exactly at receipt acknowledgement.
  const failing = {$transaction: (fn: any, options: any) => db.$transaction(async tx => {
    const wrapped = new Proxy(tx, {get(target, name) {
      if (name === "messageDeliveryReceipt") return new Proxy(target.messageDeliveryReceipt, {get(delegate, method) {
        if (method === "update") return (args: any) => {
          if (args.data.processedAt) throw Error("TEST_ACK_FAILURE");
          return delegate.update(args);
        };
        const value = Reflect.get(delegate, method);
        return typeof value === "function" ? value.bind(delegate) : value;
      }});
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    return fn(wrapped);
  }, options)} as unknown as PrismaClient;
  await assert.rejects(recover(failing, enabled), /TEST_ACK_FAILURE/);
  assert.equal((await db.messageLog.findUniqueOrThrow({where: {id: message.id}})).deliveredAt, null);
  assert.equal((await db.messageDeliveryReceipt.findUniqueOrThrow({where: {id: key}})).processedAt, null);
  await db.$disconnect(); await db.$connect();
  const results = await Promise.all([recover(db, enabled), recover(db, enabled)]);
  assert.ok(results.every(result => result.providerCalls === 0));
  const applied = await db.messageLog.findUniqueOrThrow({where: {id: message.id}});
  assert.equal(applied.providerDeliveryStatus, "DELIVERED");
  assert.equal(applied.deliveredAt?.toISOString(), eventAt.toISOString());
  assert.equal(applied.status, "E7_SENDING");
  assert.equal(applied.retryCount, 0);
  const ack = await db.messageDeliveryReceipt.findUniqueOrThrow({where: {id: key}});
  assert.ok(ack.processedAt);
  assert.equal(ack.processedMessageLogId, message.id);
  for (const untouched of [other, legacy]) {
    assert.equal((await db.messageLog.findUniqueOrThrow({where: {id: untouched.id}})).deliveredAt, null);
  }
  await recover(db, enabled);
  assert.deepEqual(await db.messageLog.findUniqueOrThrow({where: {id: message.id}}), applied);
  // Semantically duplicate receipt is consumed without changing delivery timestamps.
  await db.messageDeliveryReceipt.create({data: {...receipt, id: key + "_duplicate", eventKey: key + "_duplicate"}});
  await recover(db, enabled);
  assert.equal((await db.messageDeliveryReceipt.findUniqueOrThrow({where: {id: key + "_duplicate"}})).lastOutcome, "ALREADY_CURRENT");
  // A second same-account message makes correlation ambiguous; leave evidence pending.
  await db.messageLog.create({data: messageData});
  await db.messageDeliveryReceipt.create({data: {...receipt, id: key + "_ambiguous", eventKey: key + "_ambiguous"}});
  await recover(db, enabled);
  const ambiguous = await db.messageDeliveryReceipt.findUniqueOrThrow({where: {id: key + "_ambiguous"}});
  assert.equal(ambiguous.lastOutcome, "AMBIGUOUS");
  assert.equal(ambiguous.processedAt, null);
});
