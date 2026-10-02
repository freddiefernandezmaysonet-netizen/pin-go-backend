import assert from "node:assert/strict";
import test from "node:test";
import { checkStayTimeRequest } from "./stay-time-tool.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";
import { createConversationMemory } from "./conversation-memory.js";
import type { PinAIRuntimeRequest } from "./contracts.js";

const request: PinAIRuntimeRequest = { context: { organizationId: "org", propertyId: "property", reservationId: "stay",
  guestId: "guest", currentLocalDateTime: "2099-01-01T00:00Z", preferredLanguage: "es" }, conversation: [] };
function fixture(options: { early?: boolean; conflict?: boolean; error?: boolean; disabled?: boolean } = {}) {
  let reads = 0;
  const rule = { enabled: !options.disabled, limitLocalTime: "14:00", fee: { mode: "FIXED", amountMinor: 1000, currency: "USD" } };
  const db = { async $transaction(callback: (tx: any) => Promise<unknown>, config: any) {
    assert.equal(this, db);
    assert.equal(config.isolationLevel, "RepeatableRead");
    if (options.error) throw new Error("secret connection data");
    return callback({ reservation: { async findFirst(args: any) {
      reads++;
      if (args.where.id === "stay") {
        assert.equal(args.where.propertyId, "property");
        assert.equal(args.where.property.organizationId, "org");
        return { id: "stay", propertyId: "property", status: "ACTIVE", paymentState: "PAID",
          source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT", currency: "usd",
          checkIn: new Date("2030-10-01T19:00Z"), checkOut: new Date("2030-10-03T15:00Z"), updatedAt: new Date("2030-09-30T00:00Z"),
          property: { timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00",
            stayTimeSettings: { earlyCheckin: { ...rule, limitLocalTime: "12:00" }, lateCheckout: rule },
            stayTimeSettingsRevision: 2, cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180,
            updatedAt: new Date("2030-09-30T00:00Z") } };
      }
      return options.conflict ? { checkIn: new Date("2030-10-03T18:00Z"), checkOut: new Date("2030-10-04T15:00Z") } : null;
    } }, propertyBlockedDate: { async findFirst() { return null; } },
    reservationModification: { async findFirst() { return null; }, async findMany() { return []; } } });
  } };
  return { db: db as any, reads: () => reads };
}
test("real executor routes late checkout to scoped estimate and ignores conversational clock", async () => {
  const f = fixture();
  const executor = new PinGoRuntimeReadToolExecutor(f.db);
  const result = await executor.execute("check_late_checkout", { requestedLocalTime: "12:00" }, request, createConversationMemory(request));
  assert.equal(result.decision, "ESTIMATE_ONLY");
  assert.equal(result.feeSubtotalMinor, 1000);
  assert.equal(result.settingsRevision, 2);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.executionAvailable, false);
  assert.match(String(result.note), /antes de impuestos/);
  assert.ok(f.reads() > 0);
});
test("early tool cannot approve an arrival without canonical readiness", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(fixture().db);
  const result = await executor.execute("check_early_checkin", { requestedLocalTime: "12:00" }, request, createConversationMemory(request));
  assert.equal(result.decision, "WAITING_FOR_CLEANING_READINESS");
  assert.equal(result.reason, "ARRIVAL_READINESS_REQUIRED");
  assert.equal(result.authorizationGranted, false);
});
test("model arguments cannot override scope, operation, price or server time", async () => {
  for (const key of ["reservationId", "organizationId", "propertyId", "operation", "fee", "now"]) {
    const f = fixture();
    const result = await checkStayTimeRequest(f.db, "LATE_CHECKOUT", { requestedLocalTime: "12:00", [key]: "forged" }, request);
    assert.equal(result.decision, "INVALID_REQUEST");
    assert.equal(f.reads(), 0);
  }
});
test("missing or malformed time prompts for HH:mm before database access", async () => {
  for (const time of [undefined, 12, "25:00", "12:00:00"]) {
    const f = fixture();
    const result = await checkStayTimeRequest(f.db, "LATE_CHECKOUT", { requestedLocalTime: time }, request);
    assert.equal(result.decision, "REQUESTED_TIME_REQUIRED");
    assert.equal(f.reads(), 0);
  }
});
test("disabled, occupied and failed checks never fall back to legacy eligibility", async () => {
  for (const [options, decision] of [[{ disabled: true }, "SERVICE_DISABLED"], [{ conflict: true }, "NOT_OPERATIONALLY_AVAILABLE"], [{ error: true }, "UNAVAILABLE"]] as const) {
    const result = await checkStayTimeRequest(fixture(options).db, "LATE_CHECKOUT", { requestedLocalTime: "12:00" }, request);
    assert.equal(result.decision, decision);
    assert.equal(result.authorizationGranted, false);
    assert.doesNotMatch(JSON.stringify(result), /secret connection/);
  }
  const result = await checkStayTimeRequest(undefined, "LATE_CHECKOUT", { requestedLocalTime: "12:00" }, request);
  assert.equal(result.decision, "UNAVAILABLE");
});
test("English estimate states no hold, tax exclusion and no completed action", async () => {
  const result = await checkStayTimeRequest(fixture().db, "LATE_CHECKOUT", { requestedLocalTime: "12:00" },
    { ...request, context: { ...request.context, preferredLanguage: "en" } });
  assert.match(String(result.note), /before taxes/);
  assert.equal(result.availabilityHeld, false);
  assert.equal(result.actionExecuted, false);
});
