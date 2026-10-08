import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const source = await readFile(new URL("./cleaning-confirmation-dispatch.service.ts", import.meta.url), "utf8");
test("skipped oldest offers do not block a later eligible offer across timestamp ties", async () => {
  const a = source.indexOf("export async function processPendingCleaningConfirmations(");
  const queries: any[] = []; const checked: string[] = [];
  const older = Array.from({ length: 25 }, (_, i) => ({ id: `a-${String(i).padStart(2, "0")}`, createdAt: new Date("2026-10-07T12:00:00Z") }));
  const waiting = [...older, { id: "later-eligible", createdAt: older[0].createdAt }];
  const db: any = { cleaningConfirmation: { findMany: async (query: any) => { queries.push(query); const boundary = query.where.OR?.[1]; return waiting.filter(row => !boundary || row.createdAt > boundary.createdAt || (row.createdAt.getTime() === boundary.createdAt.getTime() && row.id > boundary.id.gt)).slice(0, query.take); } } };
  const sent: string[] = [];
  const context: any = { exports: {}, Date, console: { error: () => {} },
    maybeFallbackCleaningConfirmation: async ({ confirmation }: any) => { checked.push(confirmation.id); return { fallbackCreated: false, reason: confirmation.id === "later-eligible" ? "sms_not_sent_yet" : "cleaning_nfc_disabled" }; },
    sendCleaningConfirmationSms: async ({ confirmation }: any) => { assert.equal(confirmation.id, "later-eligible"); sent.push(confirmation.id); return { ok: true, skipped: false }; } };
  runInNewContext(ts.transpileModule(source.slice(a), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  await context.exports.processPendingCleaningConfirmations(db);
  await context.exports.processPendingCleaningConfirmations(db);
  assert.equal(checked.length, 52);
  assert.equal(sent.length, 2);
  assert.equal(checked.includes("later-eligible"), true);
  assert.equal(queries.length, 4);
  assert.equal(queries[1].where.OR[1].id.gt, "a-24");
});
