import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { resolveCapturedReceiptMessage as resolve } from "./message-delivery-account-binding.service";

test("PostgreSQL correlation isolates accounts, refuses ambiguity and leaves legacy messages untouched", async t => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/pin_go_message_delivery_outcomes");
  const db = new PrismaClient();
  const key = "binding_" + randomUUID();
  const orgA = await db.organization.create({data: {name: key + "_a"}});
  const orgB = await db.organization.create({data: {name: key + "_b"}});
  t.after(async () => {
    await db.messageLog.deleteMany({where: {providerMessageId: key}});
    await db.property.deleteMany({where: {organizationId: {in: [orgA.id, orgB.id]}}});
    await db.organization.deleteMany({where: {id: {in: [orgA.id, orgB.id]}}});
    await db.$disconnect();
  });
  const propA = await db.property.create({data: {name: key, organizationId: orgA.id}});
  const propB = await db.property.create({data: {name: key, organizationId: orgB.id}});
  const common = {provider: "resend", providerMessageId: key, channel: "email",
    to: "fixture@example.test", body: "fixture", status: "E7_SENDING"};
  const a = await db.messageLog.create({data: {...common, organizationId: orgA.id,
    propertyId: propA.id, providerAccountKey: "account_a"}});
  const b = await db.messageLog.create({data: {...common, organizationId: orgB.id,
    propertyId: propB.id, providerAccountKey: "account_b"}});
  const legacy = await db.messageLog.create({data: {...common, organizationId: orgA.id, propertyId: propA.id}});
  const receipt = {provider: "resend", accountKey: "account_a", providerMessageId: key};
  const before = await db.messageLog.findMany({where: {providerMessageId: key}, orderBy: {id: "asc"}});
  await db.$disconnect(); await db.$connect();
  const matchA = await resolve(db, receipt);
  const matchB = await resolve(db, {...receipt, accountKey: "account_b"});
  assert.equal(matchA.state, "MATCHED");
  assert.equal(matchA.messageLogId, a.id);
  assert.equal(matchA.organizationId, orgA.id);
  assert.equal(matchB.messageLogId, b.id);
  assert.equal(matchB.organizationId, orgB.id);
  assert.deepEqual(await resolve(db, {...receipt, accountKey: "account_missing"}), {state: "UNBOUND_OR_UNKNOWN"});
  assert.deepEqual(await db.messageLog.findMany({where: {providerMessageId: key}, orderBy: {id: "asc"}}), before,
    "readiness resolution must never mutate delivery, create sends, or backfill old accounts");
  assert.equal((await db.messageLog.findUniqueOrThrow({where: {id: legacy.id}})).providerAccountKey, null);
  const duplicate = await db.messageLog.create({data: {...common, organizationId: orgB.id,
    propertyId: propB.id, providerAccountKey: "account_a"}});
  assert.deepEqual(await resolve(db, receipt), {state: "AMBIGUOUS"});
  await db.messageLog.delete({where: {id: duplicate.id}});
  await db.messageLog.update({where: {id: a.id}, data: {propertyId: propB.id}});
  assert.deepEqual(await resolve(db, receipt), {state: "SCOPE_MISMATCH"});
});
