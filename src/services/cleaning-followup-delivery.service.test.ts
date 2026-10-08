import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./cleaning-followup-delivery.service.ts", import.meta.url), "utf8");
function fixture() {
  const work: any = { id: "w", confirmationId: "c", staffMemberId: "s", reservationId: "r", propertyId: "p", cancelledAt: null, supersededAt: null, completionConfirmedAt: null, startConfirmedAt: null };
  const staff: any = { phoneE164: "+15555550100", preferredLanguage: "es", isActive: true, organizationId: "o" };
  const reservation: any = { id: "r", propertyId: "p", status: "ACTIVE", property: { name: "Property", organizationId: "o", status: "ACTIVE" } };
  const offer: any = { id: "c", token: "token", status: "CONFIRMED", staffMemberId: "s", reservationId: "r", propertyId: "p" };
  let latest: any = work; let offers = [offer]; let reads = 0;
  const messages: any[] = [];
  const db: any = { cleaningFollowupReceipt: { findUnique: async () => ({ id: "receipt", cleaningWorkId: "w", deliveryStatus: "CLAIMED", kind: "START_REMINDER" }), update: async () => ({}) },
    cleaningWork: { findUnique: async () => ++reads === 1 ? work : latest },
    staffMember: { findUnique: async () => staff, findFirst: async () => staff },
    reservation: { findUnique: async () => reservation, findFirst: async () => reservation },
    cleaningConfirmation: { findUnique: async () => offer, findMany: async () => offers } };
  const context: any = { exports: {}, process: { env: { API_BASE_URL: "https://api.test", NODE_ENV: "test" } }, URL, Date, Promise,
    require: (name: string) => {
      if (name.includes("messaging.service")) return { sendLoggedSms: async (args: any) => { messages.push(args); return { ok: true, sid: "fake" }; } };
      if (name.includes("sms-body")) return { buildCleanerFollowupSms: (args: any) => `${args.language}: ${args.actionUrl}` };
      if (name.includes("staff-language")) return { resolveStaffLanguage: (v: string) => v };
      throw new Error(name);
    } };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return { work, staff, reservation, offer, messages, latest: (v: any) => { latest = v; }, offers: (v: any[]) => { offers = v; }, run: () => context.exports.deliverClaimedCleanerFollowup(db, "receipt") };
}
test("current cleaner receives existing reminder in preferred language", async () => { const f = fixture(); assert.equal((await f.run()).delivered, true); assert.match(f.messages[0].body, /^es:/); assert.match(f.messages[0].body, /confirm\/token$/); });
for (const key of ["cancelledAt", "supersededAt", "completionConfirmedAt", "startConfirmedAt"]) test(`${key} during context reads suppresses initial SMS`, async () => { const f = fixture(); f.latest({ ...f.work, [key]: new Date() }); assert.equal((await f.run()).delivered, false); assert.equal(f.messages.length, 0); });
test("pending backup and multiple current offers suppress initial SMS", async () => { for (const ambiguous of [false, true]) { const f = fixture(); f.offers(ambiguous ? [f.offer, { ...f.offer, id: "backup" }] : [{ ...f.offer, id: "backup", status: "PENDING" }]); assert.equal((await f.run()).delivered, false); assert.equal(f.messages.length, 0); } });
test("inactive staff and cancelled reservation suppress initial SMS", async () => { for (const inactive of [false, true]) { const f = fixture(); if (inactive) f.staff.isActive = false; else f.reservation.status = "CANCELLED"; assert.equal((await f.run()).delivered, false); assert.equal(f.messages.length, 0); } });
test("foreign confirmation owner cannot receive reminder", async () => { const f = fixture(); f.offer.staffMemberId = "other"; assert.equal((await f.run()).delivered, false); assert.equal(f.messages.length, 0); });
