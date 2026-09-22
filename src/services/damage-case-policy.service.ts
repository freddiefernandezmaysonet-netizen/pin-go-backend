import { DamagePaymentMethodStatus } from "@prisma/client";

export type DamageCaseReservationPolicySnapshot = {
  propertyProtectionRequiredSnapshot: boolean | null;
  maxDamageLiabilityAmountSnapshot: unknown;
  damagePaymentMethodStatus: DamagePaymentMethodStatus;
  stripeDamageCustomerId: string | null;
  stripeDamagePaymentMethodId: string | null;
};

export type DamageCasePolicyResult =
  | {
      ok: true;
      maximumLiabilityAmount: number;
      requestedAmount: number;
      approvedAmount: number | null;
    }
  | {
      ok: false;
      code:
        | "PROPERTY_PROTECTION_NOT_REQUIRED"
        | "CARD_ON_FILE_NOT_READY"
        | "DAMAGE_AMOUNT_INVALID"
        | "DAMAGE_AMOUNT_EXCEEDS_RESERVATION_LIMIT";
    };

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Number(amount.toFixed(2));
}

export function evaluateDamageCasePolicy(input: {
  reservation: DamageCaseReservationPolicySnapshot;
  requestedAmount: unknown;
  approvedAmount?: unknown;
}): DamageCasePolicyResult {
  const maximumLiabilityAmount = money(
    input.reservation.maxDamageLiabilityAmountSnapshot
  );
  const requestedAmount = money(input.requestedAmount);
  const approvedAmount =
    input.approvedAmount === undefined
      ? null
      : money(input.approvedAmount);

  if (
    input.reservation.propertyProtectionRequiredSnapshot !== true ||
    maximumLiabilityAmount === null ||
    maximumLiabilityAmount <= 0
  ) {
    return { ok: false, code: "PROPERTY_PROTECTION_NOT_REQUIRED" };
  }

  if (
    input.reservation.damagePaymentMethodStatus !==
      DamagePaymentMethodStatus.READY ||
    !String(input.reservation.stripeDamageCustomerId ?? "").startsWith("cus_") ||
    !String(input.reservation.stripeDamagePaymentMethodId ?? "").startsWith("pm_")
  ) {
    return { ok: false, code: "CARD_ON_FILE_NOT_READY" };
  }

  if (
    requestedAmount === null ||
    requestedAmount <= 0 ||
    (input.approvedAmount !== undefined &&
      (approvedAmount === null || approvedAmount <= 0))
  ) {
    return { ok: false, code: "DAMAGE_AMOUNT_INVALID" };
  }

  if (
    requestedAmount > maximumLiabilityAmount ||
    (approvedAmount !== null &&
      (approvedAmount > requestedAmount ||
        approvedAmount > maximumLiabilityAmount))
  ) {
    return {
      ok: false,
      code: "DAMAGE_AMOUNT_EXCEEDS_RESERVATION_LIMIT",
    };
  }

  return {
    ok: true,
    maximumLiabilityAmount,
    requestedAmount,
    approvedAmount,
  };
}
