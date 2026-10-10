import assert from "node:assert/strict";
import test from "node:test";
import { commercialReservationChangesEnabled } from "./reservation-change-commercial-policy.js";
import { PIN_AI_BILLING_TERMS } from "../billing-terms.js";

const now = new Date("2026-10-10T14:00:00Z");
const scope = { organizationId: "org", propertyId: "property", reservationId: "reservation" };
const env = { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true",
  PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
  PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true" };
function fixture() {
  const property = { pinAIEnabled: true, pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
    organization: { pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: "acct_host" } };
  const reservation = { status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: null as string | null,
    checkIn: new Date(+now - 86400000), checkOut: new Date(+now + 86400000),
    property: { isPublicBookable: true, pinAITermsAcceptedAt: new Date(+now - 1000), pinAITermsAcceptedBy: "host" } };
  const db = { property: { findFirst: async ({ where }: any) => where.organizationId === scope.organizationId ? property : null },
    reservation: { findFirst: async ({ where }: any) => where.id === scope.reservationId &&
      where.propertyId === scope.propertyId && where.property.organizationId === scope.organizationId ? reservation : null } } as never;
  return { property, reservation, db };
}
test("activated Direct Booking changes are available without a reservation allowlist or hourly settings", async () => {
  const f = fixture();
  assert.equal(await commercialReservationChangesEnabled(f.db, env, scope, now), true);
  f.reservation.checkIn = new Date(+now + 12 * 3600000);
  assert.equal(await commercialReservationChangesEnabled(f.db, env, scope, now), true);
});
test("commercial scope preserves tenant isolation and cannot fall back to the pilot after opt-out", async () => {
  const f = fixture(), flags = { ...env, PIN_AI_ACTION_CANARY_RESERVATION_IDS: scope.reservationId };
  for (const changed of [{ organizationId: "other" }, { propertyId: "other" }, { reservationId: "other" }]) {
    assert.equal(await commercialReservationChangesEnabled(f.db, flags, { ...scope, ...changed }, now), false);
  }
  f.property.pinAIEnabled = false;
  assert.equal(await commercialReservationChangesEnabled(f.db, flags, scope, now), false);
  f.property.pinAIEnabled = true; f.property.organization.pinAIEnabled = false;
  assert.equal(await commercialReservationChangesEnabled(f.db, flags, scope, now), false);
});
test("host consent, payment, channel, booking status and the action window remain required", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.reservation.paymentState = "UNPAID"; },
    (f: ReturnType<typeof fixture>) => { f.reservation.status = "CANCELLED"; },
    (f: ReturnType<typeof fixture>) => { f.reservation.source = "CHANNEX"; f.reservation.externalProvider = "AIRBNB"; },
    (f: ReturnType<typeof fixture>) => { f.reservation.checkOut = now; },
    (f: ReturnType<typeof fixture>) => { f.reservation.checkIn = new Date(+now + 2 * 86400000); f.reservation.checkOut = new Date(+now + 3 * 86400000); },
    (f: ReturnType<typeof fixture>) => { f.reservation.property.isPublicBookable = false; },
    (f: ReturnType<typeof fixture>) => { f.reservation.property.pinAITermsAcceptedBy = ""; },
    (f: ReturnType<typeof fixture>) => { f.reservation.property.pinAITermsAcceptedAt = new Date(+now + 1000); },
    (f: ReturnType<typeof fixture>) => { f.property.pinAITermsVersion = "old-version"; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(await commercialReservationChangesEnabled(f.db, env, scope, now), false);
  }
});
test("global action switches retain their kill-switch and legacy selected-reservation behavior", async () => {
  for (const flag of ["PIN_AI_ACTION_BROKER_ENABLED", "PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED"] as const) {
    assert.equal(await commercialReservationChangesEnabled(fixture().db, { ...env, [flag]: "false" }, scope, now), false);
  }
  const flags = { PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true",
    PIN_AI_ACTION_CANARY_RESERVATION_IDS: scope.reservationId };
  assert.equal(await commercialReservationChangesEnabled({} as never, flags, scope, now), true);
  assert.equal(await commercialReservationChangesEnabled({} as never, flags, { ...scope, reservationId: "other" }, now), false);
});
