import assert from "node:assert/strict";
import test from "node:test";
import { DamagePaymentMethodStatus } from "@prisma/client";
import { evaluateDamageCasePolicy } from "./damage-case-policy.service";

const readyReservation = {
  propertyProtectionRequiredSnapshot: true,
  maxDamageLiabilityAmountSnapshot: 500,
  damagePaymentMethodStatus: DamagePaymentMethodStatus.READY,
  stripeDamageCustomerId: "cus_damage_ready",
  stripeDamagePaymentMethodId: "pm_damage_ready",
};

test("Damage Case accepts an amount within the immutable reservation limit", () => {
  assert.deepEqual(
    evaluateDamageCasePolicy({
      reservation: readyReservation,
      requestedAmount: 275,
    }),
    {
      ok: true,
      maximumLiabilityAmount: 500,
      requestedAmount: 275,
      approvedAmount: null,
    }
  );
});

test("Damage Case rejects reservations without Property Protection", () => {
  assert.deepEqual(
    evaluateDamageCasePolicy({
      reservation: {
        ...readyReservation,
        propertyProtectionRequiredSnapshot: false,
      },
      requestedAmount: 100,
    }),
    { ok: false, code: "PROPERTY_PROTECTION_NOT_REQUIRED" }
  );
});

test("Damage Case requires a READY connected Card on File", () => {
  assert.deepEqual(
    evaluateDamageCasePolicy({
      reservation: {
        ...readyReservation,
        damagePaymentMethodStatus: DamagePaymentMethodStatus.ACTION_REQUIRED,
      },
      requestedAmount: 100,
    }),
    { ok: false, code: "CARD_ON_FILE_NOT_READY" }
  );
});

test("Damage Case rejects zero, negative, or malformed amounts", () => {
  for (const requestedAmount of [0, -1, "not-money"]) {
    assert.deepEqual(
      evaluateDamageCasePolicy({
        reservation: readyReservation,
        requestedAmount,
      }),
      { ok: false, code: "DAMAGE_AMOUNT_INVALID" }
    );
  }
});

test("Damage Case cannot exceed the reservation liability snapshot", () => {
  assert.deepEqual(
    evaluateDamageCasePolicy({
      reservation: readyReservation,
      requestedAmount: 500.01,
    }),
    {
      ok: false,
      code: "DAMAGE_AMOUNT_EXCEEDS_RESERVATION_LIMIT",
    }
  );
});

test("host approval cannot exceed either requested amount or liability snapshot", () => {
  assert.deepEqual(
    evaluateDamageCasePolicy({
      reservation: readyReservation,
      requestedAmount: 300,
      approvedAmount: 301,
    }),
    {
      ok: false,
      code: "DAMAGE_AMOUNT_EXCEEDS_RESERVATION_LIMIT",
    }
  );
  assert.equal(
    evaluateDamageCasePolicy({
      reservation: readyReservation,
      requestedAmount: 500,
      approvedAmount: 500,
    }).ok,
    true
  );
});
