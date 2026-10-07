import test from "node:test";
import assert from "node:assert/strict";
import { retireObsoleteCleaningReminder } from "./cleaning-reminder-retry.service.js";
function fixture() {
  const now = new Date("2026-10-07T16:30:00Z");
  const message = { id: "msg", communicationType: "CLEANING_FOLLOWUP_START_REMINDER", body: "Reminder https://api.test/cleaning/confirm/token", to: "+15555550100", reservationId: "r", propertyId: "p", organizationId: "o" };
  const work: any = { scheduledStartAt: new Date("2026-10-07T16:00:00Z"), durationCommitmentMinutes: 90, startConfirmationGraceMinutes: 30, followupGraceMinutes: 15, timingConsentAcceptedAt: now, startConfirmedAt: null, completionConfirmedAt: null, cancelledAt: null, supersededAt: null };
  let offers: any[] = [{ id: "c", staffMemberId: "s", token: "token", status: "CONFIRMED" }];
  let reservation: any = {}; let staff: any = {};
  const writes: any[] = [];
  const db: any = { cleaningConfirmation: { findMany: async () => offers }, reservation: { findFirst: async () => reservation }, staffMember: { findFirst: async () => staff }, cleaningWork: { findMany: async () => [work] }, messageLog: { updateMany: async (x: any) => { writes.push(x); return { count: 1 }; } } };
  return { message, work, now, writes, setOffers: (v: any[]) => { offers = v; }, noReservation: () => { reservation = null; }, noStaff: () => { staff = null; }, run: () => retireObsoleteCleaningReminder(db, message, now) };
}
test("current start reminder may retry at its original grace boundary", async () => { const f = fixture(); assert.equal(await f.run(), false); assert.equal(f.writes.length, 0); });
for (const field of ["cancelledAt", "supersededAt", "completionConfirmedAt", "startConfirmedAt"]) test(`${field} prevents stale start retry`, async () => { const f = fixture(); f.work[field] = f.now; assert.equal(await f.run(), true); assert.equal(f.writes[0].data.status, "OBSOLETE"); });
test("backup token cannot replace original SMS identity", async () => { const f = fixture(); f.setOffers([{ id: "backup", staffMemberId: "b", token: "backup-token", status: "CONFIRMED" }]); assert.equal(await f.run(), true); });
test("pending or ambiguous offers suppress retry", async () => { for (const offers of [[{ status: "PENDING", token: "token" }], [{ status: "CONFIRMED", token: "token" }, { status: "CONFIRMED", token: "token" }]]) { const f = fixture(); f.setOffers(offers); assert.equal(await f.run(), true); } });
test("cancelled reservation and changed recipient suppress retry", async () => { for (const missing of ["noReservation", "noStaff"] as const) { const f = fixture(); f[missing](); assert.equal(await f.run(), true); } });
test("completion reminder retries only during its original phase", async () => { const f = fixture(); f.message.communicationType = "CLEANING_FOLLOWUP_COMPLETION_REMINDER"; f.now.setTime(new Date("2026-10-07T17:30:00Z").getTime()); assert.equal(await f.run(), false); f.now.setTime(new Date("2026-10-07T17:45:00Z").getTime()); assert.equal(await f.run(), true); });
test("malformed context is retired and unrelated SMS is untouched", async () => { const f = fixture(); f.message.body = "No action URL"; assert.equal(await f.run(), true); f.message.communicationType = "CHECKOUT"; assert.equal(await f.run(), false); assert.equal(f.writes.length, 1); });

test("actual retry worker skips obsolete reminders before Twilio and preserves unrelated retry", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const ts = await import("typescript");
  const source = await readFile(new URL("../workers/message.retry.worker.ts", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("async function processRetries()"), source.indexOf("async function processGuestAccessEmailRetries()"));
  for (const obsolete of [true, false]) {
    let sent = 0; let validated = 0;
    const context: any = { prisma: { messageLog: { findMany: async () => [{ id: "m", body: "old", to: "synthetic", communicationType: "CLEANING_FOLLOWUP_START_REMINDER", retryCount: 0 }], update: async () => ({}) } }, MAX_RETRIES: 5, BATCH_SIZE: 20,
      retireAirbnbLegacyRetry: async () => false, yieldsToGuestJourneyCommunicationsOwner: () => false,
      isNonRetryableSmsError: () => false, buildGuestAccessSmsRetryBody: async () => "old",
      retireObsoleteCleaningReminder: async () => { validated++; return obsolete; },
      sendSms: async () => { sent++; return { sid: "synthetic" }; }, log: () => {}, errLog: () => {}, toErrString: String };
    runInNewContext(ts.transpileModule(section + "\nglobalThis.run = processRetries;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    await context.run();
    assert.equal(validated, 1); assert.equal(sent, obsolete ? 0 : 1);
  }
});

test("retired routine SMS templates never retry even without a communication type", async () => {
  for (const prefix of ["cleaning ready.", "limpieza lista.", "cleaning start.", "inicio de limpieza.", "cleaning done.", "limpieza terminada."]) {
    const f = fixture(); f.message.communicationType = ""; f.message.body = `Pin&Go ${prefix} Prop: Test`;
    assert.equal(await f.run(), true); assert.equal(f.writes[0].data.error, "CLEANING_ROUTINE_SMS_RETIRED");
  }
});
