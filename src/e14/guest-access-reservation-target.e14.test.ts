import assert from "node:assert/strict";
import test from "node:test";

import {
  selectGuestAccessReservationTarget,
} from "./guest-access-reservation-target.e14.js";

const CHECK_IN = new Date("2026-08-28T15:00:00.000Z");
const CHECK_OUT = new Date("2026-08-30T11:00:00.000Z");

function candidate(
  id: string,
  startsAt: Date,
  endsAt: Date
) {
  return { id, startsAt, endsAt };
}

test("canonical current-window grant is selected ahead of an older sibling", () => {
  const stale = candidate(
    "grant-stale",
    new Date("2026-08-27T15:00:00.000Z"),
    new Date("2026-08-29T11:00:00.000Z")
  );
  const canonical = candidate(
    "grant-canonical",
    new Date(CHECK_IN),
    new Date(CHECK_OUT)
  );

  const selected = selectGuestAccessReservationTarget(
    [stale, canonical],
    { checkIn: CHECK_IN, checkOut: CHECK_OUT }
  );

  assert.equal(selected?.id, "grant-canonical");
});

test("zero canonical grants retain one deterministic target for fail-closed quarantine", () => {
  const first = candidate(
    "grant-first",
    new Date("2026-08-26T15:00:00.000Z"),
    new Date("2026-08-28T11:00:00.000Z")
  );
  const second = candidate(
    "grant-second",
    new Date("2026-08-27T15:00:00.000Z"),
    new Date("2026-08-29T11:00:00.000Z")
  );

  const selected = selectGuestAccessReservationTarget(
    [first, second],
    { checkIn: CHECK_IN, checkOut: CHECK_OUT }
  );

  assert.equal(selected?.id, "grant-first");
});

test("multiple canonical grants retain deterministic selection for reservation-level cardinality rejection", () => {
  const first = candidate(
    "grant-first",
    new Date(CHECK_IN),
    new Date(CHECK_OUT)
  );
  const second = candidate(
    "grant-second",
    new Date(CHECK_IN),
    new Date(CHECK_OUT)
  );

  const selected = selectGuestAccessReservationTarget(
    [first, second],
    { checkIn: CHECK_IN, checkOut: CHECK_OUT }
  );

  assert.equal(selected?.id, "grant-first");
});

test("empty reservation grant set has no execution target", () => {
  assert.equal(
    selectGuestAccessReservationTarget([], {
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
    }),
    null
  );
});

test("canonical current-window grant is selected beyond the legacy fifth position", () => {
  const stale = Array.from({ length: 6 }, (_, index) =>
    candidate(
      `grant-stale-${index + 1}`,
      new Date(
        CHECK_IN.getTime() -
          (index + 1) * 24 * 60 * 60_000
      ),
      new Date(
        CHECK_OUT.getTime() -
          (index + 1) * 24 * 60 * 60_000
      )
    )
  );
  const canonical = candidate(
    "grant-canonical-seventh",
    new Date(CHECK_IN),
    new Date(CHECK_OUT)
  );

  const selected = selectGuestAccessReservationTarget(
    [...stale, canonical],
    { checkIn: CHECK_IN, checkOut: CHECK_OUT }
  );

  assert.equal(selected?.id, "grant-canonical-seventh");
});
