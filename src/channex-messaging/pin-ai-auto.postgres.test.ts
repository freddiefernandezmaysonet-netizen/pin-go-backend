import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createAutoRepository } from "./pin-ai-auto.repository.js";

const connection = process.env.INBOX_POSTGRES_TEST_URL;
test("Postgres: duplicate webhooks, competing workers, host fence and crash recovery", { skip: !connection }, async () => {
  const url = new URL(connection!); assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const schema = `ai_inbox_${randomUUID().replaceAll("-", "")}`, admin = new PrismaClient({ datasourceUrl: url.toString() });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); url.searchParams.set("schema", schema);
  const a = new PrismaClient({ datasourceUrl: url.toString() }), b = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const sql = await readFile(new URL("../../prisma/migrations/20261003181000_channex_pin_ai_inbound/migration.sql", import.meta.url), "utf8");
    for (const statement of sql.split(";").filter(x => x.trim())) await a.$executeRawUnsafe(statement);
    const repo = createAutoRepository(a), other = createAutoRepository(b);
    const input = { organizationId: "org", propertyId: "property", threadId: "thread", messageId: "message" }, since = new Date("2026-01-01T00:00:00Z");
    await Promise.all([repo.enqueue(input), other.enqueue(input)]);
    assert.equal(await a.channexAIInbound.count(), 1);
    const candidate = (await repo.candidates())[0]!;
    const claims = await Promise.all([repo.claim(candidate, since), other.claim(candidate, since)]);
    assert.equal(claims.filter(Boolean).length, 1); const job = claims.find(Boolean)!;
    await repo.control(input, "HUMAN", since); assert.equal(await other.fence(job), false);
    await repo.finish(job, "NEEDS_HOST", "HOST_TAKEOVER");
    await repo.control(input, "AUTO", new Date());
    await repo.enqueue({ ...input, messageId: "message-2" });
    const second = await repo.claim((await repo.candidates())[0]!, since); assert.ok(second);
    assert.equal(await repo.fence(second), true);
    const paused = await other.control(input, "HUMAN", since); assert.equal(paused.sending, true);
    await a.channexAIInbound.update({ where: { id: second.id }, data: { leaseUntil: new Date(0) } });
    await a.channexAIThread.updateMany({ data: { leaseUntil: new Date(0) } });
    const recovered = await other.claim((await other.candidates())[0]!, since); assert.equal(recovered?.status, "SENDING");
    await repo.finish(second, "SENT", "STALE_WORKER");
    assert.equal((await a.channexAIInbound.findUniqueOrThrow({ where: { id: second.id } })).status, "SENDING");
    await other.finish(recovered!, "UNKNOWN", "RECONCILE");
    assert.equal((await repo.state(input))?.mode, "HUMAN"); assert.equal((await repo.candidates()).length, 0);
  } finally { await a.$disconnect(); await b.$disconnect(); await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); }
});
