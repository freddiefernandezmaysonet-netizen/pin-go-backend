import assert from "node:assert/strict";
import test from "node:test";
import { readCleanerCardPeriodEvidence } from "./cleaner-nfc-period-evidence.service";

const input = { lockId: 42, cardId: 123, accessToken: "synthetic-token", now: new Date("2026-10-27T16:00Z") };
const card = { lockId: 42, cardId: 123, startDate: Date.parse("2026-10-27T16:45Z"), endDate: Date.parse("2026-10-27T19:45Z") };
const read = (rows: unknown[]) => readCleanerCardPeriodEvidence(input, { listCards: async () => ({ list: rows }) });
test("future provider period is reported without claiming physical entry", async () => {
  const result = await read([card]);
  assert.equal(result.status, "REPORTED"); assert.equal(result.periodState, "FUTURE");
  assert.equal(result.physicalAccessVerified, false);
  assert.equal(result.startsAt?.getTime(), card.startDate);
});
test("provider period expires at its exclusive upper bound", async () => {
  const result = await readCleanerCardPeriodEvidence({ ...input, now: new Date(card.endDate) },
    { listCards: async () => ({ list: [card] }) });
  assert.equal(result.periodState, "EXPIRED"); assert.equal(result.physicalAccessVerified, false);
});
test("card absence does not prove physical withdrawal", async () => {
  const result = await read([]);
  assert.equal(result.status, "NOT_LISTED"); assert.equal(result.physicalAccessVerified, false);
});
test("same card ID with a different lock is unresolved", async () => {
  assert.equal((await read([{ ...card, lockId: 99 }])).status, "UNVERIFIED");
});
test("malformed inventory cannot establish card absence", async () => {
  assert.equal((await read([{}])).status, "UNVERIFIED");
});
test("duplicate target rows are ambiguous", async () => {
  assert.equal((await read([card, card])).status, "AMBIGUOUS");
});
test("permanent, malformed and pending periods remain unverified", async () => {
  for (const row of [{ ...card, startDate: 0, endDate: 0 }, { ...card, endDate: null },
    { ...card, endDate: card.startDate }, { ...card, status: 6 }]) {
    assert.equal((await read([row])).status, "UNVERIFIED");
  }
});
test("pagination finds the exact target after the first full page", async () => {
  const calls: number[] = [];
  const result = await readCleanerCardPeriodEvidence(input, { listCards: async args => {
    assert.equal(args.lockId, 42); assert.equal(args.accessToken, "synthetic-token");
    calls.push(args.pageNo);
    return { list: args.pageNo === 1 ? Array.from({ length: 100 }, (_, i) => ({ cardId: 1000 + i, lockId: 42 })) : [card] };
  } });
  assert.equal(result.status, "REPORTED"); assert.deepEqual(calls, [1, 2]);
});
test("scan exhaustion is not absence", async () => {
  const result = await readCleanerCardPeriodEvidence(input, { listCards: async () => ({
    list: Array.from({ length: 100 }, (_, i) => ({ cardId: 1000 + i, lockId: 42 })),
  }) });
  assert.equal(result.status, "UNVERIFIED");
});
test("invalid input never calls the provider", async () => {
  const result = await readCleanerCardPeriodEvidence({ ...input, lockId: 0 },
    { listCards: async () => { throw new Error("unexpected provider call"); } });
  assert.equal(result.status, "UNVERIFIED");
});
test("provider failures propagate to recovery without false evidence", async () => {
  await assert.rejects(readCleanerCardPeriodEvidence(input,
    { listCards: async () => { throw new Error("gateway unavailable"); } }), /unavailable/);
});
