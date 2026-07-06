import {
  CancellationActor,
  CancellationPolicyType,
  CancellationRefundBasis,
  PrismaClient,
} from "@prisma/client";

const prisma = new PrismaClient();

type MoneyInput = unknown;

export type CancellationPolicySnapshot = {
  policyId: string | null;
  name: string;
  type: CancellationPolicyType;
  source: string;
  guestSelfCancellationEnabled: boolean;
  autoRefundEligibleCancellations: boolean;
  requireHostApprovalOutsidePolicy: boolean;
  freeCancellationHoursBeforeCheckIn: number;
  refundBasis: CancellationRefundBasis;
  refundPercentBeforeDeadline: number;
  refundPercentAfterDeadline: number;
  cleaningFeeRefundable: boolean;
  amenitiesRefundable: boolean;
  taxesRefundable: boolean;
  nonRefundableDiscountPercent: number | null;
  description: string | null;
  snapshotAt: string;
};

export type CancellationPolicyEvaluation = {
  policySnapshot: CancellationPolicySnapshot;
  requestedAt: string;
  checkIn: string;
  freeCancellationDeadline: string;
  hoursBeforeCheckIn: number;
  beforeDeadline: boolean;
  refundPercent: number;
  refundAmount: number;
  refundAmountCents: number;
  eligibleForGuestSelfCancellation: boolean;
  eligibleForAutoRefund: boolean;
  requiresHostApproval: boolean;
  reason: string;
  actor: CancellationActor;
  breakdown: {
    totalAmount: number;
    totalAmountCents: number;
    nightlySubtotal: number;
    nightlySubtotalCents: number;
    cleaningFee: number;
    cleaningFeeCents: number;
    amenitiesTotal: number;
    amenitiesTotalCents: number;
    taxesTotal: number;
    taxesTotalCents: number;
    refundableBase: number;
    refundableBaseCents: number;
  };
};

export type DashboardCancellationPolicyInput = {
  name?: string;
  type?: CancellationPolicyType;
  guestSelfCancellationEnabled?: boolean;
  autoRefundEligibleCancellations?: boolean;
  requireHostApprovalOutsidePolicy?: boolean;
  freeCancellationHoursBeforeCheckIn?: number;
  refundBasis?: CancellationRefundBasis;
  refundPercentBeforeDeadline?: number;
  refundPercentAfterDeadline?: number;
  cleaningFeeRefundable?: boolean;
  amenitiesRefundable?: boolean;
  taxesRefundable?: boolean;
  nonRefundableDiscountPercent?: number | null;
  description?: string | null;
};

function toNumber(value: MoneyInput, fallback = 0) {
  if (value === null || value === undefined) return fallback;

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toCents(value: MoneyInput) {
  return Math.max(0, Math.round(toNumber(value) * 100));
}

function fromCents(cents: number) {
  return Number((Math.max(0, Math.round(cents)) / 100).toFixed(2));
}

function clampPercent(value: MoneyInput, fallback = 0) {
  return Math.max(0, Math.min(100, toNumber(value, fallback)));
}

function getRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function readFirstNumber(record: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      const value = Number(record[key]);
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
}

function getPricingComponents({
  totalAmount,
  pricingBreakdown,
}: {
  totalAmount: MoneyInput;
  pricingBreakdown: unknown;
}) {
  const breakdown = getRecord(pricingBreakdown);

  const totalAmountCents = toCents(totalAmount);

  const cleaningFeeCents = toCents(
    readFirstNumber(breakdown, ["cleaningFee", "cleaningFeeTotal"]) ?? 0
  );

  const amenitiesTotalCents = toCents(
    readFirstNumber(breakdown, ["amenitiesTotal", "amenityTotal"]) ?? 0
  );

  const taxesTotalCents = toCents(
    readFirstNumber(breakdown, ["taxesTotal", "taxTotal"]) ?? 0
  );

  const nightlySubtotalFromBreakdown = readFirstNumber(breakdown, [
    "nightlySubtotal",
    "nightlyTotal",
    "nightlyRatesTotal",
    "subtotal",
  ]);

  const nightlySubtotalCents =
    nightlySubtotalFromBreakdown !== null
      ? toCents(nightlySubtotalFromBreakdown)
      : Math.max(
          0,
          totalAmountCents -
            cleaningFeeCents -
            amenitiesTotalCents -
            taxesTotalCents
        );

  return {
    totalAmountCents,
    nightlySubtotalCents,
    cleaningFeeCents,
    amenitiesTotalCents,
    taxesTotalCents,
  };
}

function buildDefaultCancellationPolicySnapshot(): CancellationPolicySnapshot {
  return {
    policyId: null,
    name: "Flexible",
    type: CancellationPolicyType.FLEXIBLE,
    source: "PIN_GO_DEFAULT",
    guestSelfCancellationEnabled: true,
    autoRefundEligibleCancellations: true,
    requireHostApprovalOutsidePolicy: true,
    freeCancellationHoursBeforeCheckIn: 168,
    refundBasis: CancellationRefundBasis.TOTAL_AMOUNT,
    refundPercentBeforeDeadline: 100,
    refundPercentAfterDeadline: 0,
    cleaningFeeRefundable: true,
    amenitiesRefundable: true,
    taxesRefundable: true,
    nonRefundableDiscountPercent: null,
    description:
      "Guests can cancel for a full refund until 7 days before check-in. After that deadline, host approval is required.",
    snapshotAt: new Date().toISOString(),
  };
}

function toCancellationPolicySnapshot(policy: any): CancellationPolicySnapshot {
  if (!policy) {
    return buildDefaultCancellationPolicySnapshot();
  }

  return {
    policyId: policy.id,
    name: policy.name,
    type: policy.type,
    source: policy.source,
    guestSelfCancellationEnabled: Boolean(
      policy.guestSelfCancellationEnabled
    ),
    autoRefundEligibleCancellations: Boolean(
      policy.autoRefundEligibleCancellations
    ),
    requireHostApprovalOutsidePolicy: Boolean(
      policy.requireHostApprovalOutsidePolicy
    ),
    freeCancellationHoursBeforeCheckIn: Math.max(
      0,
      Number(policy.freeCancellationHoursBeforeCheckIn ?? 0)
    ),
    refundBasis: policy.refundBasis,
    refundPercentBeforeDeadline: clampPercent(
      policy.refundPercentBeforeDeadline,
      100
    ),
    refundPercentAfterDeadline: clampPercent(
      policy.refundPercentAfterDeadline,
      0
    ),
    cleaningFeeRefundable: Boolean(policy.cleaningFeeRefundable),
    amenitiesRefundable: Boolean(policy.amenitiesRefundable),
    taxesRefundable: Boolean(policy.taxesRefundable),
    nonRefundableDiscountPercent:
      policy.nonRefundableDiscountPercent === null ||
      policy.nonRefundableDiscountPercent === undefined
        ? null
        : clampPercent(policy.nonRefundableDiscountPercent),
    description: policy.description ?? null,
    snapshotAt: new Date().toISOString(),
  };
}

const CANCELLATION_POLICY_TYPE_VALUES = new Set<string>(
  Object.values(CancellationPolicyType)
);

const CANCELLATION_REFUND_BASIS_VALUES = new Set<string>(
  Object.values(CancellationRefundBasis)
);

function isCancellationPolicyType(value: unknown): value is CancellationPolicyType {
  return (
    typeof value === "string" && CANCELLATION_POLICY_TYPE_VALUES.has(value)
  );
}

function isCancellationRefundBasis(
  value: unknown
): value is CancellationRefundBasis {
  return (
    typeof value === "string" && CANCELLATION_REFUND_BASIS_VALUES.has(value)
  );
}

function toOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function serializeCancellationPolicySnapshotForStripeMetadata(
  snapshot: CancellationPolicySnapshot
) {
  return JSON.stringify({
    v: 1,
    id: snapshot.policyId,
    n: snapshot.name,
    t: snapshot.type,
    s: snapshot.source,
    g: snapshot.guestSelfCancellationEnabled,
    a: snapshot.autoRefundEligibleCancellations,
    h: snapshot.requireHostApprovalOutsidePolicy,
    hrs: snapshot.freeCancellationHoursBeforeCheckIn,
    b: snapshot.refundBasis,
    rb: snapshot.refundPercentBeforeDeadline,
    ra: snapshot.refundPercentAfterDeadline,
    cf: snapshot.cleaningFeeRefundable,
    af: snapshot.amenitiesRefundable,
    tf: snapshot.taxesRefundable,
    nr: snapshot.nonRefundableDiscountPercent,
    at: snapshot.snapshotAt,
  });
}

export function deserializeCancellationPolicySnapshotFromStripeMetadata(
  raw: unknown
): CancellationPolicySnapshot | null {
  const rawString = typeof raw === "string" ? raw.trim() : "";

  if (!rawString) return null;

  try {
    const parsed = JSON.parse(rawString);
    const record = getRecord(parsed);
    const fallback = buildDefaultCancellationPolicySnapshot();

    return {
      policyId: toOptionalString(record.id),
      name: toOptionalString(record.n) || fallback.name,
      type: isCancellationPolicyType(record.t) ? record.t : fallback.type,
      source: toOptionalString(record.s) || fallback.source,
      guestSelfCancellationEnabled: toBoolean(
        record.g,
        fallback.guestSelfCancellationEnabled
      ),
      autoRefundEligibleCancellations: toBoolean(
        record.a,
        fallback.autoRefundEligibleCancellations
      ),
      requireHostApprovalOutsidePolicy: toBoolean(
        record.h,
        fallback.requireHostApprovalOutsidePolicy
      ),
      freeCancellationHoursBeforeCheckIn: Math.max(
        0,
        Math.round(toNumber(record.hrs, fallback.freeCancellationHoursBeforeCheckIn))
      ),
      refundBasis: isCancellationRefundBasis(record.b)
        ? record.b
        : fallback.refundBasis,
      refundPercentBeforeDeadline: clampPercent(
        record.rb,
        fallback.refundPercentBeforeDeadline
      ),
      refundPercentAfterDeadline: clampPercent(
        record.ra,
        fallback.refundPercentAfterDeadline
      ),
      cleaningFeeRefundable: toBoolean(
        record.cf,
        fallback.cleaningFeeRefundable
      ),
      amenitiesRefundable: toBoolean(
        record.af,
        fallback.amenitiesRefundable
      ),
      taxesRefundable: toBoolean(record.tf, fallback.taxesRefundable),
      nonRefundableDiscountPercent:
        record.nr === null || record.nr === undefined
          ? null
          : clampPercent(record.nr),
      description: null,
      snapshotAt: toOptionalString(record.at) || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function getRefundableBaseCents({
  snapshot,
  totalAmountCents,
  nightlySubtotalCents,
  cleaningFeeCents,
  amenitiesTotalCents,
  taxesTotalCents,
}: {
  snapshot: CancellationPolicySnapshot;
  totalAmountCents: number;
  nightlySubtotalCents: number;
  cleaningFeeCents: number;
  amenitiesTotalCents: number;
  taxesTotalCents: number;
}) {
  if (snapshot.refundBasis === CancellationRefundBasis.NIGHTLY_SUBTOTAL) {
    return nightlySubtotalCents;
  }

  if (snapshot.refundBasis === CancellationRefundBasis.NIGHTLY_PLUS_CLEANING) {
    return (
      nightlySubtotalCents +
      (snapshot.cleaningFeeRefundable ? cleaningFeeCents : 0)
    );
  }

  let refundableBaseCents = totalAmountCents;

  if (!snapshot.cleaningFeeRefundable) {
    refundableBaseCents -= cleaningFeeCents;
  }

  if (!snapshot.amenitiesRefundable) {
    refundableBaseCents -= amenitiesTotalCents;
  }

  if (!snapshot.taxesRefundable) {
    refundableBaseCents -= taxesTotalCents;
  }

  return Math.max(0, refundableBaseCents);
}

function normalizePolicyName(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.trim() : "";

  return text || fallback;
}

function normalizeDescription(value: unknown) {
  if (value === null) return null;

  const text = typeof value === "string" ? value.trim() : "";

  return text || null;
}

function normalizeNonRefundableDiscount(value: unknown) {
  if (value === null || value === undefined || value === "") return null;

  return clampPercent(value, 0);
}

function normalizeHours(value: unknown, fallback: number) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) return fallback;

  return Math.max(0, Math.round(numberValue));
}

function isPolicyType(value: unknown): value is CancellationPolicyType {
  return (
    typeof value === "string" &&
    Object.values(CancellationPolicyType).includes(
      value as CancellationPolicyType
    )
  );
}

function isRefundBasis(value: unknown): value is CancellationRefundBasis {
  return (
    typeof value === "string" &&
    Object.values(CancellationRefundBasis).includes(
      value as CancellationRefundBasis
    )
  );
}

function getPolicyPresetDefaults(type: CancellationPolicyType) {
  if (type === CancellationPolicyType.MODERATE) {
    return {
      name: "Moderate",
      freeCancellationHoursBeforeCheckIn: 120,
      refundPercentBeforeDeadline: 100,
      refundPercentAfterDeadline: 50,
    };
  }

  if (type === CancellationPolicyType.FIRM) {
    return {
      name: "Firm",
      freeCancellationHoursBeforeCheckIn: 168,
      refundPercentBeforeDeadline: 100,
      refundPercentAfterDeadline: 50,
    };
  }

  if (type === CancellationPolicyType.STRICT) {
    return {
      name: "Strict",
      freeCancellationHoursBeforeCheckIn: 336,
      refundPercentBeforeDeadline: 50,
      refundPercentAfterDeadline: 0,
    };
  }

  if (type === CancellationPolicyType.NON_REFUNDABLE) {
    return {
      name: "Non-refundable",
      freeCancellationHoursBeforeCheckIn: 0,
      refundPercentBeforeDeadline: 0,
      refundPercentAfterDeadline: 0,
    };
  }

  if (type === CancellationPolicyType.CUSTOM) {
    return {
      name: "Custom",
      freeCancellationHoursBeforeCheckIn: 168,
      refundPercentBeforeDeadline: 100,
      refundPercentAfterDeadline: 0,
    };
  }

  return {
    name: "Flexible",
    freeCancellationHoursBeforeCheckIn: 168,
    refundPercentBeforeDeadline: 100,
    refundPercentAfterDeadline: 0,
  };
}

function serializeDashboardPolicy(policy: any) {
  if (!policy) return null;

  return {
    id: policy.id,
    propertyId: policy.propertyId,
    name: policy.name,
    type: policy.type,
    source: policy.source,
    isActive: policy.isActive,
    guestSelfCancellationEnabled: policy.guestSelfCancellationEnabled,
    autoRefundEligibleCancellations: policy.autoRefundEligibleCancellations,
    requireHostApprovalOutsidePolicy:
      policy.requireHostApprovalOutsidePolicy,
    freeCancellationHoursBeforeCheckIn:
      policy.freeCancellationHoursBeforeCheckIn,
    refundBasis: policy.refundBasis,
    refundPercentBeforeDeadline: Number(
      policy.refundPercentBeforeDeadline
    ),
    refundPercentAfterDeadline: Number(policy.refundPercentAfterDeadline),
    cleaningFeeRefundable: policy.cleaningFeeRefundable,
    amenitiesRefundable: policy.amenitiesRefundable,
    taxesRefundable: policy.taxesRefundable,
    nonRefundableDiscountPercent:
      policy.nonRefundableDiscountPercent === null ||
      policy.nonRefundableDiscountPercent === undefined
        ? null
        : Number(policy.nonRefundableDiscountPercent),
    description: policy.description ?? null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

export async function getActiveCancellationPolicyForProperty(
  propertyId: string
) {
  return prisma.propertyCancellationPolicy.findFirst({
    where: {
      propertyId,
      isActive: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });
}

export async function buildCancellationPolicySnapshot(propertyId: string) {
  const policy = await getActiveCancellationPolicyForProperty(propertyId);

  return toCancellationPolicySnapshot(policy);
}

export function evaluateCancellationPolicy({
  snapshot,
  checkIn,
  totalAmount,
  pricingBreakdown,
  requestedAt = new Date(),
  actor = CancellationActor.GUEST,
}: {
  snapshot: CancellationPolicySnapshot;
  checkIn: Date;
  totalAmount: MoneyInput;
  pricingBreakdown?: unknown;
  requestedAt?: Date;
  actor?: CancellationActor;
}): CancellationPolicyEvaluation {
  const checkInMs = checkIn.getTime();
  const requestedAtMs = requestedAt.getTime();

  const deadline = new Date(
    checkInMs - snapshot.freeCancellationHoursBeforeCheckIn * 60 * 60 * 1000
  );

  const beforeDeadline = requestedAtMs <= deadline.getTime();

  const refundPercent = beforeDeadline
    ? snapshot.refundPercentBeforeDeadline
    : snapshot.refundPercentAfterDeadline;

  const {
    totalAmountCents,
    nightlySubtotalCents,
    cleaningFeeCents,
    amenitiesTotalCents,
    taxesTotalCents,
  } = getPricingComponents({
    totalAmount,
    pricingBreakdown,
  });

  const refundableBaseCents = getRefundableBaseCents({
    snapshot,
    totalAmountCents,
    nightlySubtotalCents,
    cleaningFeeCents,
    amenitiesTotalCents,
    taxesTotalCents,
  });

  const refundAmountCents = Math.min(
    totalAmountCents,
    Math.max(0, Math.round(refundableBaseCents * (refundPercent / 100)))
  );

  const outsidePolicy = !beforeDeadline;
  const requiresHostApproval =
    !snapshot.guestSelfCancellationEnabled ||
    (outsidePolicy && snapshot.requireHostApprovalOutsidePolicy);

  const eligibleForGuestSelfCancellation =
    snapshot.guestSelfCancellationEnabled && !requiresHostApproval;

  const eligibleForAutoRefund =
    eligibleForGuestSelfCancellation &&
    snapshot.autoRefundEligibleCancellations &&
    refundAmountCents > 0;

  const hoursBeforeCheckIn =
    (checkInMs - requestedAtMs) / (1000 * 60 * 60);

  const reason = requiresHostApproval
    ? "CANCELLATION_REQUIRES_HOST_APPROVAL"
    : refundAmountCents > 0
    ? "CANCELLATION_ELIGIBLE_FOR_AUTO_REFUND"
    : "CANCELLATION_ELIGIBLE_WITH_NO_REFUND";

  return {
    policySnapshot: snapshot,
    requestedAt: requestedAt.toISOString(),
    checkIn: checkIn.toISOString(),
    freeCancellationDeadline: deadline.toISOString(),
    hoursBeforeCheckIn: Number(hoursBeforeCheckIn.toFixed(2)),
    beforeDeadline,
    refundPercent,
    refundAmount: fromCents(refundAmountCents),
    refundAmountCents,
    eligibleForGuestSelfCancellation,
    eligibleForAutoRefund,
    requiresHostApproval,
    reason,
    actor,
    breakdown: {
      totalAmount: fromCents(totalAmountCents),
      totalAmountCents,
      nightlySubtotal: fromCents(nightlySubtotalCents),
      nightlySubtotalCents,
      cleaningFee: fromCents(cleaningFeeCents),
      cleaningFeeCents,
      amenitiesTotal: fromCents(amenitiesTotalCents),
      amenitiesTotalCents,
      taxesTotal: fromCents(taxesTotalCents),
      taxesTotalCents,
      refundableBase: fromCents(refundableBaseCents),
      refundableBaseCents,
    },
  };
}

export async function evaluateReservationCancellationPolicy({
  reservationId,
  organizationId,
  requestedAt = new Date(),
  actor = CancellationActor.GUEST,
}: {
  reservationId: string;
  organizationId: string;
  requestedAt?: Date;
  actor?: CancellationActor;
}) {
  const reservation = await prisma.reservation.findFirst({
    where: {
      id: reservationId,
      property: {
        organizationId,
      },
    },
    select: {
      id: true,
      propertyId: true,
      checkIn: true,
      totalAmount: true,
      pricingBreakdown: true,
      cancellationPolicySnapshot: true,
    },
  });

  if (!reservation) {
    throw new Error("RESERVATION_NOT_FOUND");
  }

  const snapshot =
    reservation.cancellationPolicySnapshot &&
    typeof reservation.cancellationPolicySnapshot === "object"
      ? (reservation.cancellationPolicySnapshot as CancellationPolicySnapshot)
      : await buildCancellationPolicySnapshot(reservation.propertyId);

  return evaluateCancellationPolicy({
    snapshot,
    checkIn: reservation.checkIn,
    totalAmount: reservation.totalAmount,
    pricingBreakdown: reservation.pricingBreakdown,
    requestedAt,
    actor,
  });
}

export async function getDashboardCancellationPolicy({
  organizationId,
  propertyId,
}: {
  organizationId: string;
  propertyId: string;
}) {
  const property = await prisma.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
      status: "ACTIVE",
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!property) {
    throw new Error("PROPERTY_NOT_FOUND");
  }

  const policy = await getActiveCancellationPolicyForProperty(property.id);

  return {
    property,
    policy: serializeDashboardPolicy(policy),
    defaultPolicy: buildDefaultCancellationPolicySnapshot(),
  };
}

export async function upsertDashboardCancellationPolicy({
  organizationId,
  propertyId,
  input,
}: {
  organizationId: string;
  propertyId: string;
  input: DashboardCancellationPolicyInput;
}) {
  const property = await prisma.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
      status: "ACTIVE",
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!property) {
    throw new Error("PROPERTY_NOT_FOUND");
  }

  const existingPolicy = await getActiveCancellationPolicyForProperty(
    property.id
  );

  const requestedType = isPolicyType(input.type)
    ? input.type
    : existingPolicy?.type ?? CancellationPolicyType.FLEXIBLE;

  const presetDefaults = getPolicyPresetDefaults(requestedType);

  const refundBasis = isRefundBasis(input.refundBasis)
    ? input.refundBasis
    : existingPolicy?.refundBasis ?? CancellationRefundBasis.TOTAL_AMOUNT;

  const data = {
    propertyId: property.id,
    name: normalizePolicyName(
      input.name,
      existingPolicy?.name ?? presetDefaults.name
    ),
    type: requestedType,
    source: "CUSTOM",
    isActive: true,

    guestSelfCancellationEnabled:
      typeof input.guestSelfCancellationEnabled === "boolean"
        ? input.guestSelfCancellationEnabled
        : existingPolicy?.guestSelfCancellationEnabled ?? true,

    autoRefundEligibleCancellations:
      typeof input.autoRefundEligibleCancellations === "boolean"
        ? input.autoRefundEligibleCancellations
        : existingPolicy?.autoRefundEligibleCancellations ?? true,

    requireHostApprovalOutsidePolicy:
      typeof input.requireHostApprovalOutsidePolicy === "boolean"
        ? input.requireHostApprovalOutsidePolicy
        : existingPolicy?.requireHostApprovalOutsidePolicy ?? true,

    freeCancellationHoursBeforeCheckIn: normalizeHours(
      input.freeCancellationHoursBeforeCheckIn,
      existingPolicy?.freeCancellationHoursBeforeCheckIn ??
        presetDefaults.freeCancellationHoursBeforeCheckIn
    ),

    refundBasis,

    refundPercentBeforeDeadline: clampPercent(
      input.refundPercentBeforeDeadline,
      existingPolicy
        ? Number(existingPolicy.refundPercentBeforeDeadline)
        : presetDefaults.refundPercentBeforeDeadline
    ),

    refundPercentAfterDeadline: clampPercent(
      input.refundPercentAfterDeadline,
      existingPolicy
        ? Number(existingPolicy.refundPercentAfterDeadline)
        : presetDefaults.refundPercentAfterDeadline
    ),

    cleaningFeeRefundable:
      typeof input.cleaningFeeRefundable === "boolean"
        ? input.cleaningFeeRefundable
        : existingPolicy?.cleaningFeeRefundable ?? true,

    amenitiesRefundable:
      typeof input.amenitiesRefundable === "boolean"
        ? input.amenitiesRefundable
        : existingPolicy?.amenitiesRefundable ?? true,

    taxesRefundable:
      typeof input.taxesRefundable === "boolean"
        ? input.taxesRefundable
        : existingPolicy?.taxesRefundable ?? true,

    nonRefundableDiscountPercent: normalizeNonRefundableDiscount(
      input.nonRefundableDiscountPercent ??
        existingPolicy?.nonRefundableDiscountPercent
    ),

    description: normalizeDescription(
      input.description ?? existingPolicy?.description
    ),
  };

  const policy = existingPolicy
    ? await prisma.propertyCancellationPolicy.update({
        where: {
          id: existingPolicy.id,
        },
        data,
      })
    : await prisma.propertyCancellationPolicy.create({
        data,
      });

  return {
    property,
    policy: serializeDashboardPolicy(policy),
  };
}