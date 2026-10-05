import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { guestAccessWindow, guestAccessNeedsSync, synchronizeGuestAccessWindow } from "./reservation-guest-access-window";

const date = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));

for (const scenario of [
  { name: "early check-in only", start: 13, end: 20, changed: true },
  { name: "late checkout only", start: 15, end: 22, changed: true },
  { name: "both boundaries", start: 13, end: 22, changed: true },
  { name: "unchanged timestamps in new Date objects", start: 15, end: 20, changed: false },
  { name: "shortened access", start: 16, end: 19, changed: true },
]) {
  test(`guest access window: ${scenario.name}`, () => {
    const current = { startsAt: date(15), endsAt: date(20) };
    const reservation = { checkIn: date(scenario.start), checkOut: date(scenario.end) };
    const next = guestAccessWindow(current, reservation);
    assert.equal(next.changed, scenario.changed);
    assert.equal(next.startsAt.getTime(), reservation.checkIn.getTime());
    assert.equal(next.endsAt.getTime(), reservation.checkOut.getTime());
    assert.equal(current.startsAt.getTime(), date(15).getTime());
    assert.equal(current.endsAt.getTime(), date(20).getTime());
  });
}

test("NFC detection and application share the complete guest window", async () => {
  const source = await readFile(new URL("./reservation.reconcile.service.ts", import.meta.url), "utf8");
  assert.match(source, /if \(a.role === NfcAssignmentRole.GUEST\) \{\s*return guestAccessNeedsSync\(a, reservation, "TTLOCK_CHANGE_PERIOD_FAILED"\);/);
  assert.match(source, /const next = guestAccessWindow\(a, reservation\);/);
  assert.match(source, /startDate: next.startsAt.getTime\(\),\s*endDate: next.endsAt.getTime\(\)/);
  assert.doesNotMatch(source, /startsAt: a.startsAt/);
});

for (const prefix of ["PASSCODE_RESYNC_FAILED", "TTLOCK_CHANGE_PERIOD_FAILED"]) {
  test(`${prefix}: provider failure preserves old times and subsequent reconciliation retries`, async () => {
    let state = { startsAt: date(15), endsAt: date(20), lastError: null as string | null };
    const reservation = { checkIn: date(13), checkOut: date(22) };
    const persist = async (data: Partial<typeof state>) => { state = { ...state, ...data }; };
    let calls = 0;
    const run = () => synchronizeGuestAccessWindow({
      next: guestAccessWindow(state, reservation), errorPrefix: prefix, persist,
      synchronize: async () => {
        calls++;
        assert.equal(state.lastError, `${prefix}: PENDING`);
        assert.equal(state.startsAt.getTime(), date(15).getTime());
        if (calls === 1) throw new Error("provider unavailable");
      },
    });
    await assert.rejects(run, /provider unavailable/);
    assert.equal(state.endsAt.getTime(), date(20).getTime());
    assert.equal(guestAccessNeedsSync(state, reservation, prefix), true);
    await run();
    assert.equal(calls, 2);
    assert.equal(state.lastError, null);
    assert.equal(guestAccessNeedsSync(state, reservation, prefix), false);
  });

  test(`${prefix}: legacy failure or interrupted acknowledgement retries even with matching times`, () => {
    const reservation = { checkIn: date(15), checkOut: date(20) };
    for (const detail of ["PENDING", "FAILED", "legacy provider error"]) {
      assert.equal(guestAccessNeedsSync({ startsAt: date(15), endsAt: date(20), lastError: `${prefix}: ${detail}` }, reservation, prefix), true);
    }
    assert.equal(guestAccessNeedsSync({ startsAt: date(15), endsAt: date(20), lastError: "UNRELATED: failure" }, reservation, prefix), false);
  });
}

test("unprogrammed scheduled access updates locally without a provider call", async () => {
  const writes: unknown[] = [];
  await synchronizeGuestAccessWindow({ next: { startsAt: date(13), endsAt: date(22) }, errorPrefix: "TEST", persist: async data => { writes.push(data); } });
  assert.deepEqual(writes, [{ startsAt: date(13), endsAt: date(22), lastError: null }]);
});

test("failure to persist intent prevents external I/O", async () => {
  let calls = 0;
  await assert.rejects(synchronizeGuestAccessWindow({
    next: { startsAt: date(13), endsAt: date(22) }, errorPrefix: "TEST",
    persist: async () => { throw new Error("database unavailable"); },
    synchronize: async () => { calls++; },
  }), /database unavailable/);
  assert.equal(calls, 0);
});

test("failed acknowledgement leaves the pending intent retryable", async () => {
  let error: string | null = null;
  await assert.rejects(synchronizeGuestAccessWindow({
    next: { startsAt: date(13), endsAt: date(22) }, errorPrefix: "TEST",
    persist: async data => {
      if (data.startsAt) throw new Error("acknowledgement failed");
      error = data.lastError;
    },
    synchronize: async () => {},
  }), /acknowledgement failed/);
  assert.equal(error, "TEST: PENDING");
});

test("debounce, provisioning and missing hardware cannot acknowledge the new window", async () => {
  const source = await readFile(new URL("./reservation.reconcile.service.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!plan.hardwareNeedSync\) throw new Error\("NFC_RESYNC_DEBOUNCED"\)/);
  for (const reason of ["NFC_RESYNC_DEBOUNCED", "NFC_RESYNC_PROVISIONING_PENDING", "NFC_RESYNC_TARGET_MISSING", "PASSCODE_RESYNC_TARGET_MISSING"]) {
    assert.ok(source.includes(`throw new Error("${reason}")`));
    const writes: unknown[] = [];
    await assert.rejects(synchronizeGuestAccessWindow({
      next: { startsAt: date(13), endsAt: date(22) }, errorPrefix: "TEST",
      persist: async data => { writes.push(data); },
      synchronize: async () => { throw new Error(reason); },
    }), new RegExp(reason));
    assert.deepEqual(writes, [{ lastError: "TEST: PENDING" }, { lastError: "TEST: FAILED" }]);
  }
});
