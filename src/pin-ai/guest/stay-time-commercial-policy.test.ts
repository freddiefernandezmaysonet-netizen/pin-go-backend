import assert from "node:assert/strict";
import test from "node:test";
import { commercialStayTimeChatEnabled } from "./stay-time-commercial-policy.js";
import { PIN_AI_BILLING_TERMS } from "../billing-terms.js";
const now = new Date("2026-10-07T21:00:00Z");
const scope = { organizationId: "org", propertyId: "property", reservationId: "reservation" };
const env = { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true",
  PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
  PIN_AI_STAY_TIME_CHAT_ENABLED: "true", PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true" };
const rule = { enabled: true, limitLocalTime: "12:00", fee: { mode: "FREE", amountMinor: 0, currency: "USD" } };
function fixture() {
  const property = { pinAIEnabled: true, pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
    organization: { pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: "acct_host" } };
  const reservation = { status: "ACTIVE", checkIn: now, checkOut: new Date(+now + 86400000),
    property: { pinAITermsAcceptedAt: new Date(+now - 1000), pinAITermsAcceptedBy: "host",
      stayTimeSettings: { earlyCheckin: { ...rule }, lateCheckout: { ...rule, enabled: false } } as unknown } };
  const db = { property: { findFirst: async ({ where }: any) => where.organizationId === scope.organizationId ? property : null },
    reservation: { findFirst: async ({ where }: any) => where.id === scope.reservationId && where.propertyId === scope.propertyId ? reservation : null } } as never;
  return { property, reservation, db };
}
test("activated configured property permits stay-time without a reservation pilot list", async () => {
  const f = fixture(); assert.equal(await commercialStayTimeChatEnabled(f.db, env, scope, now), true);
});
test("commercial scope cannot fall back to a canary for a disabled property or another tenant", async () => {
  const f = fixture(), flags = { ...env, PIN_AI_ACTION_CANARY_RESERVATION_IDS: scope.reservationId };
  assert.equal(await commercialStayTimeChatEnabled(f.db, flags, { ...scope, organizationId: "other" }, now), false);
  assert.equal(await commercialStayTimeChatEnabled(f.db, flags, { ...scope, reservationId: "other" }, now), false);
  f.property.pinAIEnabled = false;
  assert.equal(await commercialStayTimeChatEnabled(f.db, flags, scope, now), false);
});
test("settings, consent and current service window are required", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.reservation.property.stayTimeSettings = null; },
    (f: ReturnType<typeof fixture>) => { f.reservation.property.stayTimeSettings = { earlyCheckin: { ...rule, enabled: false }, lateCheckout: { ...rule, enabled: false } }; },
    (f: ReturnType<typeof fixture>) => { f.reservation.property.pinAITermsAcceptedBy = ""; },
    (f: ReturnType<typeof fixture>) => { f.reservation.property.pinAITermsAcceptedAt = new Date(+now + 1000); },
    (f: ReturnType<typeof fixture>) => { f.reservation.status = "CANCELLED"; },
    (f: ReturnType<typeof fixture>) => { f.reservation.checkIn = new Date(+now + 2 * 86400000); f.reservation.checkOut = new Date(+now + 3 * 86400000); },
  ]) { const f = fixture(); change(f); assert.equal(await commercialStayTimeChatEnabled(f.db, env, scope, now), false); }
});
test("global switches and legacy pilot remain independently controlled", async () => {
  const f = fixture();
  assert.equal(await commercialStayTimeChatEnabled(f.db, { ...env, PIN_AI_ACTION_BROKER_ENABLED: "false" }, scope, now), false);
  const pilot = { ...env, PIN_AI_ALL_ORGANIZATIONS_ENABLED: "false", PIN_AI_ACTION_CANARY_RESERVATION_IDS: scope.reservationId };
  assert.equal(await commercialStayTimeChatEnabled({} as never, pilot, scope, now), true);
  assert.equal(await commercialStayTimeChatEnabled({} as never, pilot, { ...scope, reservationId: "unselected" }, now), false);
});
