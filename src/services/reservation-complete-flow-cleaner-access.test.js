import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as prismaTypes from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";

// Execute the complete audit with storage and repair boundaries injected.
// No database connection, TTLock operation, email or SMS is possible here.
function fixture({ status = "ACTIVE", owned = false, pending = false, legacy = false,
  missingCard = false, windowMismatch = false, skippedRepair = false, repairedUnused = false } = {}) {
  const start = new Date("2026-10-27T16:45:00Z");
  const end = new Date("2026-10-27T19:45:00Z");
  const confirmation = { id: "backup-offer", propertyId: "property", staffMemberId: "backup",
    status: pending ? "PENDING" : "CONFIRMED" };
  const grant = { id: "nfc", nfcCardId: owned ? "backup-card" : "primary-card",
    role: "CLEANING", status, startsAt: start,
    endsAt: windowMismatch ? new Date("2026-10-27T20:45:00Z") : end };
  const reservation = { id: "reservation", propertyId: "property", status: "ACTIVE",
    source: "MANUAL", paymentState: "PAID", totalAmount: 100,
    guestTokenExpiresAt: null,
    checkIn: new Date("2026-10-26T20:00:00Z"), checkOut: new Date("2026-10-27T16:00:00Z"),
    createdAt: start, updatedAt: start,
    property: { id: "property", organizationId: "org", organization: {},
      cleaningNfcEnabled: true, timezone: "America/Puerto_Rico",
      distributionLastSyncedAt: null,
      checkInTime: "16:00", checkOutTime: "12:00", cleaningStartOffsetMinutes: 45 } };
  const repairs = [], reads = [];
  const db = {
    reservation: { findUnique: async () => reservation, count: async () => 0 },
    accessGrant: { findMany: async () => legacy ? [{ id: "old-staff-grant", type: "STAFF",
      staffMemberId: "primary", status: "ACTIVE" }] : [] },
    staffAssignment: { findMany: async () => legacy ? [{ id: "old-staff", staffMemberId: "primary",
      status: "ACTIVE", accessGrantId: "old-staff-grant" }] : [] },
    cleaningConfirmation: { findMany: async () => [confirmation] },
    nfcAssignment: { findMany: async () => [grant] },
    staffMember: { findUnique: async args => { reads.push(args); return { ttlockCardRef: "backup-ref" }; } },
    nfcCard: { findFirst: async args => { reads.push(args); return missingCard ? null : { id: "backup-card" }; } },
    messageDispatchLog: { findMany: async () => [] },
    messageLog: { findMany: async () => [] },
    apmsAuditEntry: { findMany: async () => [] },
  };
  const dependencies = {
    "@prisma/client": { ...prismaTypes, PrismaClient: class {} },
    "date-fns-tz": { fromZonedTime },
    "./cleaner-access-property-reconcile.service": { reconcilePropertyCleanerAccess: async () => {} },
    "./cleaner-access-window.service": { readCleanerAccessWindow: async () => ({ startsAt: start, endsAt: end }) },
    "./cleaner-access-autopilot.service": { ensureCleanerNfcAccessForConfirmedCleaning: async args => {
      repairs.push(args);
      if (repairedUnused) return { ok: true, skipped: false, escalated: false,
        reason: "CLEANER_NFC_ACCESS_SCHEDULED", nfcAssignmentId: "backup-new-grant" };
      return skippedRepair ? { ok: true, skipped: true, escalated: false }
        : { ok: false, skipped: false, escalated: true, reason: "CLEANER_ACCESS_CARD_MISMATCH" };
    } },
    "../apms/audit-persistence.service": { persistAuditEntry: async () => ({ id: "audit" }) },
    "../apms/operational-intelligence.service": { resolveOperationalIssuesForReservation: async () => {} },
    "../apms/reservation-operational-intelligence.mapper": { mapReservationCleaningOperationalItems: () => [] },
    "./cleaning-reassignment-attention.service.js": { persistCleaningAuditAttention: async () => {} },
  };
  const source = readFileSync(new URL("./reservation-complete-flow-audit.service.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new vm.Script(compiled.outputText).runInNewContext({ module, exports: module.exports, Date, Intl, console,
    require: key => { assert.ok(Object.hasOwn(dependencies, key), `Unexpected dependency ${key}`); return dependencies[key]; },
  });
  return { repairs, reads, run: async () => {
    const result = await module.exports.auditReservationCompleteFlow("reservation", db);
    return result.checks.find(check => check.rule === "CLEANER_ACCESS_CREATED");
  } };
}

for (const status of ["SCHEDULED", "PROVISIONING", "ACTIVE"]) {
  test(`audit rejects primary ${status} NFC for confirmed backup`, async () => {
    const f = fixture({ status, legacy: true });
    const check = await f.run();
    assert.equal(check.status, "FAIL");
    assert.equal(check.metadata.cleanerAccessReady, false);
    assert.equal(check.metadata.cleanerOwnershipError, "CLEANER_ACCESS_CARD_MISMATCH");
    assert.equal(f.repairs.length, 1);
    assert.equal(f.repairs[0].confirmationId, "backup-offer");
  });
  test(`audit preserves own-card ${status} lifecycle`, async () => {
    const f = fixture({ status, owned: true });
    const check = await f.run();
    assert.equal(check.status, status === "PROVISIONING" ? "WARNING" : "PASS");
    assert.equal(check.metadata.cleanerAccessReady, true);
    assert.equal(f.repairs.length, 0);
    assert.equal(f.reads[0].where.id, "backup");
    assert.equal(f.reads[1].where.propertyId, "property");
  });
}
test("pending backup does not inherit old NFC or legacy readiness", async () => {
  const f = fixture({ pending: true, legacy: true });
  const check = await f.run();
  assert.equal(check.metadata.cleanerAccessReady, false);
  assert.equal(check.metadata.cleanerAccessWaitingForConfirmation, true);
  assert.equal(f.repairs.length, 0);
  assert.equal(f.reads.length, 0);
});
test("missing backup card mapping fails readiness", async () => {
  assert.equal((await fixture({ missingCard: true }).run()).status, "FAIL");
});
test("own card still requires the canonical window", async () => {
  const check = await fixture({ owned: true, windowMismatch: true }).run();
  assert.equal(check.status, "FAIL");
  assert.equal(check.metadata.cleanerWindowError, "CLEANER_ACCESS_WINDOW_MISMATCH");
});
test("skipped repair cannot certify mismatched access", async () => {
  const check = await fixture({ skippedRepair: true }).run();
  assert.equal(check.status, "FAIL");
  assert.equal(check.metadata.cleanerAccessReady, false);
});
test("successful unused-grant replacement uses repair evidence rather than the retired snapshot", async () => {
  const check = await fixture({ status: "SCHEDULED", windowMismatch: true, repairedUnused: true }).run();
  assert.equal(check.status, "PASS");
  assert.equal(check.metadata.cleanerAccessReady, true);
  assert.equal(check.metadata.cleanerOwnershipError, null);
  assert.equal(check.metadata.cleanerWindowError, null);
  assert.equal(check.metadata.cleanerAccessAutopilotNfcAssignmentId, "backup-new-grant");
});
