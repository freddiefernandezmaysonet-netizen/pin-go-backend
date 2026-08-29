import assert from "node:assert/strict";
import test from "node:test";

import {
  controlledRearmPrerequisites,
  classifyProviderInventory,
  listTtlockPasscodesReadOnly,
  nextAbsenceMarker,
  type ProviderInventory,
} from "./guest-access-ambiguity-reconciliation.e15";
import {
  resolveGuestAccessAmbiguityE15Config,
} from "./guest-access-ambiguity-reconciliation.config.e15";

const startsAt = new Date("2026-09-01T15:00:00.000Z");
const endsAt = new Date("2026-09-03T11:00:00.000Z");

function inventory(items: any[], complete = true): ProviderInventory {
  return {
    complete,
    fingerprint: "fp",
    pagesRead: 1,
    items,
  };
}

test("E15 is default-off with controlled rearm independently off", () => {
  const config = resolveGuestAccessAmbiguityE15Config({} as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);
  assert.equal(config.controlledRearmEnabled, false);
});

test("E15 rejects controlled rearm when reconciliation itself is off", () => {
  assert.throws(
    () => resolveGuestAccessAmbiguityE15Config({
      GUEST_JOURNEY_E15_ACCESS_CONTROLLED_REARM_ENABLED: "true",
    } as NodeJS.ProcessEnv),
    /CONTROLLED_REARM_REQUIRES_RECONCILIATION/
  );
});

test("E15 classifies one exact active period passcode as provider-present", () => {
  const result = classifyProviderInventory({
    inventory: inventory([{
      keyboardPwdId: 77,
      keyboardPwd: "1234567",
      keyboardPwdName: "PinGo PG-1",
      keyboardPwdType: 3,
      startDate: startsAt.getTime(),
      endDate: endsAt.getTime(),
      status: 1,
    }]),
    expectedName: "PinGo PG-1",
    startsAt,
    endsAt,
  });
  assert.equal(result.kind, "EXACT_MATCH");
});

test("E15 refuses duplicate exact provider matches", () => {
  const item = {
    keyboardPwd: "1234567",
    keyboardPwdName: "PinGo PG-1",
    keyboardPwdType: 3,
    startDate: startsAt.getTime(),
    endDate: endsAt.getTime(),
    status: 1,
  };
  const result = classifyProviderInventory({
    inventory: inventory([
      { ...item, keyboardPwdId: 77 },
      { ...item, keyboardPwdId: 78 },
    ]),
    expectedName: "PinGo PG-1",
    startsAt,
    endsAt,
  });
  assert.equal(result.kind, "CONFLICT");
});

test("E15 refuses correlated provider evidence with a mismatched window", () => {
  const result = classifyProviderInventory({
    inventory: inventory([{
      keyboardPwdId: 77,
      keyboardPwd: "1234567",
      keyboardPwdName: "PinGo PG-1",
      keyboardPwdType: 3,
      startDate: startsAt.getTime() - 60_000,
      endDate: endsAt.getTime(),
      status: 1,
    }]),
    expectedName: "PinGo PG-1",
    startsAt,
    endsAt,
  });
  assert.equal(result.kind, "CONFLICT");
});

test("E15 never treats an incomplete inventory as proof of absence", () => {
  const result = classifyProviderInventory({
    inventory: inventory([], false),
    expectedName: "PinGo PG-1",
    startsAt,
    endsAt,
  });
  assert.equal(result.kind, "INCOMPLETE");
});

test("E15 requires repeated stable absence separated in time", () => {
  const first = nextAbsenceMarker({
    previous: null,
    inventoryFingerprint: "stable",
    now: new Date("2026-09-01T10:00:00.000Z"),
    minSeparationMs: 60_000,
  });
  assert.equal(first.state, "ABSENCE_OBSERVED");
  const second = nextAbsenceMarker({
    previous: first,
    inventoryFingerprint: "stable",
    now: new Date("2026-09-01T10:01:01.000Z"),
    minSeparationMs: 60_000,
  });
  assert.equal(second.state, "CONFIRMED_ABSENT_REARMABLE");
});

test("E15 resets absence quorum when provider inventory changes", () => {
  const first = nextAbsenceMarker({
    previous: null,
    inventoryFingerprint: "a",
    now: new Date("2026-09-01T10:00:00.000Z"),
    minSeparationMs: 60_000,
  });
  const second = nextAbsenceMarker({
    previous: first,
    inventoryFingerprint: "b",
    now: new Date("2026-09-01T10:02:00.000Z"),
    minSeparationMs: 60_000,
  });
  assert.equal(second.state, "ABSENCE_OBSERVED");
  assert.equal(second.observationCount, 1);
});

test("E15 controlled rearm requires E14 and Access Owner simultaneously", () => {
  assert.equal(controlledRearmPrerequisites({ configured: true, e14Enabled: true, accessOwnerEnabled: true }), true);
  assert.equal(controlledRearmPrerequisites({ configured: true, e14Enabled: false, accessOwnerEnabled: true }), false);
  assert.equal(controlledRearmPrerequisites({ configured: true, e14Enabled: true, accessOwnerEnabled: false }), false);
});

test("E15 provider reader uses GET only and stops on a short page", async () => {
  let method = "";
  const result = await listTtlockPasscodesReadOnly({
    lockId: 123,
    accessToken: "token",
    clientId: "client",
    pageSize: 100,
    maxPages: 5,
    timeoutMs: 1000,
    fetchImpl: (async (_url: any, init: any) => {
      method = init.method;
      return new Response(JSON.stringify({ list: [] }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(method, "GET");
  assert.equal(result.complete, true);
  assert.equal(result.pagesRead, 1);
});
