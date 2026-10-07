import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const source = await readFile(new URL("./reservation.worker.ts", import.meta.url), "utf8");
test("access expiry still revokes the grant without routine SMS or completing CleaningWork", async () => {
  const section = source.slice(source.indexOf("async function processCleaningEnds("), source.indexOf("async function processPasscodeResyncs("));
  const updates: any[] = []; let revokes = 0;
  const context: any = { exports: {}, fetchDueCleaningEnds: async () => [{ id: "staff-assignment", accessGrant: { id: "grant" } }], log: () => {}, errLog: () => {}, toErrString: String,
    AccessStatus: { ACTIVE: "ACTIVE", REVOKED: "REVOKED", FAILED: "FAILED" }, StaffAssignmentStatus: { COMPLETED: "COMPLETED", FAILED: "FAILED" },
    revokeStaffAccess: async () => { revokes++; }, prisma: { accessGrant: { updateMany: async () => ({ count: 1 }), update: async (x: any) => { updates.push(x); } }, staffAssignment: { update: async () => ({}) } } };
  runInNewContext(ts.transpileModule(section + "\nglobalThis.run = processCleaningEnds;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await context.run(new Date());
  assert.equal(revokes, 1); assert.equal(updates[0].data.status, "REVOKED");
  assert.doesNotMatch(section, /sendCleaningEndSms|cleaningWork/);
});
test("routine calls are absent while confirmation and reminders remain wired", () => {
  assert.doesNotMatch(source, /sendCleaningReadySms|sendCleaningStartSms|sendCleaningEndSms/);
  assert.match(source, /processPendingCleaningConfirmations/);
  assert.match(source, /deliverClaimedCleanerFollowup/);
  const parsed = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  assert.equal(parsed.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
});
