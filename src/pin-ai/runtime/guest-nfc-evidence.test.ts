import assert from "node:assert/strict";
import test from "node:test";
import { readGuestNfcEvidence, type GuestNfcEvidenceReader } from "./guest-nfc-evidence.js";
import { buildPinAIOpenAIInstructions } from "./openai-agent-config.js";

const scope = { organizationId: "org-a", propertyId: "property-a", reservationId: "reservation-a" };
const now = new Date("2026-09-27T13:23:00Z");
function assignment(overrides = {}) {
  return { id: "private-assignment", status: "FAILED", startsAt: new Date("2026-09-26T19:00Z"),
    endsAt: new Date("2026-09-27T15:00Z"), retryCount: 2, updatedAt: new Date("2026-09-27T13:22Z"),
    provisionedAt: null, provisioningStartedAt: null,
    lastError: "RETRYABLE: provider private-secret", ttlockCardId: "private-card-id",
    Reservation: { status: "ACTIVE", checkIn: new Date("2026-09-26T19:00Z"), checkOut: new Date("2026-09-28T15:00Z") },
    ...overrides };
}
function fixture(rows: any[], issues: any[] = []) {
  const calls: any[] = [];
  const db = { nfcAssignment: { async findMany(args: any) { calls.push(args); return rows; } },
    operationalIssue: { async findMany(args: any) { calls.push(args); return issues; } } } as unknown as GuestNfcEvidenceReader;
  return { db, calls };
}
test("failed physical cards expose retry and recorded incident without credentials or notification claims", async () => {
  const {db, calls} = fixture([assignment()], [{ operationalKey: "GUEST_NFC_ACTIVATION:private-assignment",
    workflowState: "ACTION_REQUIRED", visibility: "HOST", actionRequired: true, resolvedAt: null }]);
  const result = await readGuestNfcEvidence(db, scope, now);
  const card = result.cards[0]!;
  assert.equal(card.assignmentStatus, "FAILED");
  assert.equal(card.providerActivationRecorded, false);
  assert.equal(card.credentialKind, "PHYSICAL_NFC_CARD");
  assert.equal(card.retry.nextAttemptNotBefore, "2026-09-27T13:27:00.000Z");
  assert.equal(card.incident.hostAttentionRecorded, true);
  assert.equal(card.incident.hostNotificationDeliveryVerified, false);
  assert.equal(result.operationalWrites, false);
  assert.doesNotMatch(JSON.stringify(result), /private-secret|private-assignment|private-card-id|lastError|operationalKey/);
  assert.deepEqual(calls[0].where, { reservationId: scope.reservationId, role: "GUEST",
    Reservation: { propertyId: scope.propertyId, property: { organizationId: scope.organizationId } } });
  assert.equal(calls[1].where.organizationId, scope.organizationId);
  assert.equal(calls[1].where.propertyId, scope.propertyId);
  assert.equal(calls[1].where.reservationId, scope.reservationId);
});
test("recovered cards use current activation and extended dates, without claiming a physical test", async () => {
  const {db} = fixture([assignment({ status: "ACTIVE", provisionedAt: now,
    endsAt: new Date("2026-09-28T15:00Z"), lastError: null, retryCount: 3 })], [{
    operationalKey: "GUEST_NFC_ACTIVATION:private-assignment", workflowState: "RESOLVED",
    resolutionCode: "GUEST_NFC_RECOVERED", resolvedAt: now }]);
  const card = (await readGuestNfcEvidence(db, scope, now)).cards[0]!;
  assert.equal(card.providerActivationRecorded, true);
  assert.equal(card.coversCurrentStay, true);
  assert.equal(card.usableByRecordedWindowNow, true);
  assert.equal(card.physicalUseVerified, false);
  assert.equal(card.incident.recoveryRecorded, true);
  assert.equal(card.retry.eligible, false);
});
test("missing NFC evidence is distinct from failed activation and missing incident is explicit", async () => {
  const empty = fixture([]);
  assert.deepEqual((await readGuestNfcEvidence(empty.db, scope, now)).cards, []);
  assert.equal(empty.calls.length, 1);
  const {db} = fixture([assignment({lastError: "Error: TTLock errcode=1 errmsg=failed or means no"})]);
  const card = (await readGuestNfcEvidence(db, scope, now)).cards[0]!;
  assert.equal(card.assignmentStatus, "FAILED");
  assert.equal(card.incident.recorded, false);
  assert.equal(card.retry.eligible, true);
});
test("exhausted, ended and cancelled stays do not promise recovery retries", async () => {
  for (const overrides of [{retryCount:5}, {status:"ENDED"}, {Reservation:{...assignment().Reservation,status:"CANCELLED"}},
    {Reservation:{...assignment().Reservation,checkOut:new Date("2026-09-27T12:00Z")}}]) {
    const card = (await readGuestNfcEvidence(fixture([assignment(overrides)]).db,scope,now)).cards[0]!;
    assert.equal(card.retry.eligible,false);
    assert.equal(card.usableByRecordedWindowNow,false);
  }
});
test("legacy ACTIVE without provider timestamp and short access window do not certify full recovery", async () => {
  const card = (await readGuestNfcEvidence(fixture([assignment({status:"ACTIVE"})]).db,scope,now)).cards[0]!;
  assert.equal(card.providerActivationRecorded,false);
  assert.equal(card.coversCurrentStay,false);
});
test("database failure never becomes a fabricated no-cards result", async () => {
  const {db} = fixture([]);
  db.nfcAssignment.findMany = (() => { throw new Error("database unavailable"); }) as typeof db.nfcAssignment.findMany;
  await assert.rejects(readGuestNfcEvidence(db,scope,now), /database unavailable/);
});
test("bounded results signal truncation and invalid observation time fails closed", async () => {
  const {db} = fixture(Array.from({length:101},(_,i)=>assignment({id:`id-${i}`})));
  const result = await readGuestNfcEvidence(db,scope,now);
  assert.equal(result.truncated,true);
  assert.equal(result.cards.length,100);
  await assert.rejects(readGuestNfcEvidence(db,scope,new Date("invalid")),/TIME_INVALID/);
});
test("read-only and canary instructions distinguish physical NFC and lock configuration", () => {
  for (const enabled of [false,true]) {
    const instructions=buildPinAIOpenAIInstructions({enabled});
    assert.match(instructions,/not live connectivity/);
    assert.match(instructions,/Do not recommend enabling phone NFC/);
    assert.match(instructions,/does not prove an email, SMS/);
  }
});
