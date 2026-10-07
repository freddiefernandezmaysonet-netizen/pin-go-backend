import assert from "node:assert/strict";
import test from "node:test";
import { recordPinAIReservationFeeInTransaction } from "./reservation-fee.service.js";
import { enrollPinAIServiceInTransaction, accrueEnrolledPinAIFee } from "./service-enrollment.service.js";
import { collectPinAIConnectFee } from "./fee-connect.service.js";

const now = new Date("2026-10-07T20:00:00Z");
const env = { PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
  PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true" };
const scope = { organizationId: "org", propertyId: "property", reservationId: "reservation" };
test("exempt property never accrues a direct or OTA fee or scheduled enrollment", async () => {
  for (const source of ["DIRECT_BOOKING", "Airbnb"]) {
    const r = { source, externalProvider: source === "Airbnb" ? "CHANNEX" : null,
      status: "ACTIVE", checkIn: now, checkOut: new Date(+now + 86400000), property: { pinAIFeeExempt: true } };
    const tx = { reservation: { findFirst: async () => r } } as never;
    assert.equal(await recordPinAIReservationFeeInTransaction(tx, env, scope, now), "EXEMPT");
    assert.equal(await enrollPinAIServiceInTransaction(tx, env, scope, now), "EXEMPT");
  }
});
test("scheduled evidence is excluded without creating a fee", async () => {
  let saved: unknown;
  const tx = { property: { findFirst: async () => ({ pinAIFeeExempt: true }) }, pinAIServiceEnrollment: {
    findUnique: async () => ({ ...scope, status: "SCHEDULED" }), update: async ({ data }: any) => { saved = data; } } };
  const db = { $transaction: async (fn: any) => fn(tx) } as never;
  assert.equal(await accrueEnrolledPinAIFee(db, env, scope.reservationId, now), "EXEMPT");
  assert.equal((saved as any).reason, "PROPERTY_FEE_EXEMPT");
});
test("pending and uncertain exempt fees cannot contact the debit provider", async () => {
  for (const debitStartedAt of [null, now]) {
    const db = { property: { findFirst: async () => ({ pinAIFeeExempt: true }) },
      pinAIReservationFee: { findUnique: async () => ({ ...scope, billingStatus: "PENDING_CONNECT", debitStartedAt }) } } as never;
    assert.equal(await collectPinAIConnectFee(db, {} as never, env, scope.reservationId, now), "EXEMPT");
  }
});
