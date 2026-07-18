import {
  CancellationActor,
  CancellationPolicyType,
  CancellationRefundBasis,
  PrismaClient,
} from "@prisma/client";
import {
  renderCancellationPolicy,
  type CancellationPolicyModel,
  type RenderedCancellationPolicy,
} from "./cancellation-policy-renderer";

const prisma = new PrismaClient();

type MoneyInput = unknown;

export type CancellationRefundRule = {
  minHoursBeforeCheckIn: number;
  refundPercent: number;
  label: string;
  description?: string | null;
};

export type CancellationNonRefundableScenario =
  | "EARLY_DEPARTURE"
  | "DELAYED_ARRIVAL"
  | "REDUCED_NIGHTS"
  | "WEATHER_RE_SCHEDULE"
  | "OTHER";

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
  refundRules: CancellationRefundRule[];
  nonRefundableScenarios: CancellationNonRefundableScenario[];
  guestFacingSummary: string | null;
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
  usesTieredRules: boolean;
  matchedRefundRule: CancellationRefundRule | null;
  nonRefundableScenarios: CancellationNonRefundableScenario[];
  guestFacingSummary: string | null;
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
  refundRules?: CancellationRefundRule[];
  nonRefundableScenarios?: CancellationNonRefundableScenario[];
  guestFacingSummary?: string | null;
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

const NON_REFUNDABLE_SCENARIO_VALUES = new Set([
  "EARLY_DEPARTURE",
  "DELAYED_ARRIVAL",
  "REDUCED_NIGHTS",
  "WEATHER_RE_SCHEDULE",
  "OTHER",
]);

function normalizeRefundRule(value: unknown): CancellationRefundRule | null {
  const record = getRecord(value);

  const rawHours = Number(record.minHoursBeforeCheckIn);
  const rawPercent = Number(record.refundPercent);

  if (!Number.isFinite(rawHours) || rawHours < 0) {
    return null;
  }

  if (!Number.isFinite(rawPercent) || rawPercent < 0 || rawPercent > 100) {
    return null;
  }

  const minHoursBeforeCheckIn = Math.round(rawHours);
  const refundPercent = Number(rawPercent.toFixed(2));

  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim().slice(0, 80)
      : `${refundPercent}% refund`;

  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim().slice(0, 280)
      : null;

  return {
    minHoursBeforeCheckIn,
    refundPercent,
    label,
    description,
  };
}

function normalizeRefundRules(
  value: unknown,
  fallback: CancellationRefundRule[] = []
): CancellationRefundRule[] {
  const source = Array.isArray(value) ? value : fallback;

  return source
    .map(normalizeRefundRule)
    .filter((rule): rule is CancellationRefundRule => Boolean(rule))
    .sort(
      (a, b) => b.minHoursBeforeCheckIn - a.minHoursBeforeCheckIn
    );
}

function normalizeNonRefundableScenarios(
  value: unknown
): CancellationNonRefundableScenario[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => String(item ?? "").trim())
    .filter((item): item is CancellationNonRefundableScenario =>
      NON_REFUNDABLE_SCENARIO_VALUES.has(item)
    );
}

function getMatchedRefundRule({
  rules,
  hoursBeforeCheckIn,
}: {
  rules: CancellationRefundRule[];
  hoursBeforeCheckIn: number;
}) {
  return (
    rules.find(
      (rule) => hoursBeforeCheckIn >= rule.minHoursBeforeCheckIn
    ) ?? null
  );
}

function getPrimaryFreeCancellationHours(snapshot: CancellationPolicySnapshot) {
  const fullRefundRule = snapshot.refundRules.find(
    (rule) => rule.refundPercent >= 100
  );

  if (fullRefundRule) {
    return fullRefundRule.minHoursBeforeCheckIn;
  }

  return snapshot.freeCancellationHoursBeforeCheckIn;
}

function buildStrictTieredRefundRules(): CancellationRefundRule[] {
  return [
    {
      minHoursBeforeCheckIn: 720,
      refundPercent: 100,
      label: "Full refund",
      description:
        "Cancel at least 30 days before check-in and receive a 100% refund.",
    },
    {
      minHoursBeforeCheckIn: 336,
      refundPercent: 50,
      label: "Partial refund",
      description:
        "Cancel between 14 and 30 days before check-in and receive a 50% refund.",
    },
    {
      minHoursBeforeCheckIn: 0,
      refundPercent: 0,
      label: "No refund",
      description:
        "Cancel less than 14 days before check-in and no refund applies.",
    },
  ];
}

function formatCancellationWindowForGuest(hours: number) {
  const safeHours = Math.max(0, Math.round(Number(hours ?? 0)));

  if (safeHours <= 0) {
    return "after booking";
  }

  const days = safeHours / 24;

  if (Number.isInteger(days) && days >= 1) {
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  return `${safeHours} hour${safeHours === 1 ? "" : "s"}`;
}

function buildTwoStepRefundRules({
  freeCancellationHoursBeforeCheckIn,
  refundPercentBeforeDeadline,
  refundPercentAfterDeadline,
}: {
  freeCancellationHoursBeforeCheckIn: number;
  refundPercentBeforeDeadline: number;
  refundPercentAfterDeadline: number;
}): CancellationRefundRule[] {
  const hours = Math.max(
    0,
    Math.round(Number(freeCancellationHoursBeforeCheckIn ?? 0))
  );

  const beforePercent = clampPercent(refundPercentBeforeDeadline, 100);
  const afterPercent = clampPercent(refundPercentAfterDeadline, 0);
  const windowLabel = formatCancellationWindowForGuest(hours);

  const rules: CancellationRefundRule[] = [];

  if (hours > 0) {
    rules.push({
      minHoursBeforeCheckIn: hours,
      refundPercent: beforePercent,
      label: beforePercent >= 100 ? "Full refund" : "Partial refund",
      description: `Cancel at least ${windowLabel} before check-in and receive a ${formatRefundPercentForPolicy(
        beforePercent
      )} refund.`,
    });
  }

  rules.push({
    minHoursBeforeCheckIn: 0,
    refundPercent: afterPercent,
    label: afterPercent > 0 ? "Partial refund" : "No refund",
    description:
      hours > 0
        ? afterPercent > 0
          ? `Cancel less than ${windowLabel} before check-in and receive a ${formatRefundPercentForPolicy(
              afterPercent
            )} refund.`
          : `Cancel less than ${windowLabel} before check-in and no refund applies.`
        : afterPercent > 0
        ? `After booking, eligible cancellations receive a ${formatRefundPercentForPolicy(
            afterPercent
          )} refund.`
        : "This reservation is non-refundable after booking.",
  });

  return rules.sort(
    (a, b) => b.minHoursBeforeCheckIn - a.minHoursBeforeCheckIn
  );
}

function buildNonRefundableRefundRules(): CancellationRefundRule[] {
  return [
    {
      minHoursBeforeCheckIn: 0,
      refundPercent: 0,
      label: "No refund",
      description: "This reservation is non-refundable after booking.",
    },
  ];
}

function formatRefundPercentForPolicy(value: number) {
  const percent = clampPercent(value, 0);

  return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(2))}%`;
}

function isFixedPresetCancellationPolicyType(type: CancellationPolicyType) {
  return (
    type === CancellationPolicyType.STRICT ||
    type === CancellationPolicyType.NON_REFUNDABLE
  );
}

function isCustomCancellationPolicyType(type: CancellationPolicyType) {
  return type === CancellationPolicyType.CUSTOM;
}

function buildPresetRefundRulesForFields({
  type,
  freeCancellationHoursBeforeCheckIn,
  refundPercentBeforeDeadline,
  refundPercentAfterDeadline,
}: {
  type: CancellationPolicyType;
  freeCancellationHoursBeforeCheckIn: number;
  refundPercentBeforeDeadline: number;
  refundPercentAfterDeadline: number;
}) {
  if (type === CancellationPolicyType.STRICT) {
    return buildStrictTieredRefundRules();
  }

  if (type === CancellationPolicyType.NON_REFUNDABLE) {
    return buildNonRefundableRefundRules();
  }

  if (type === CancellationPolicyType.CUSTOM) {
    return buildStrictTieredRefundRules();
  }

  return buildTwoStepRefundRules({
    freeCancellationHoursBeforeCheckIn,
    refundPercentBeforeDeadline,
    refundPercentAfterDeadline,
  });
}

function buildPresetGuestFacingSummaryForFields({
  type,
  freeCancellationHoursBeforeCheckIn,
  refundPercentBeforeDeadline,
  refundPercentAfterDeadline,
}: {
  type: CancellationPolicyType;
  freeCancellationHoursBeforeCheckIn: number;
  refundPercentBeforeDeadline: number;
  refundPercentAfterDeadline: number;
}) {
  if (type === CancellationPolicyType.STRICT) {
    return "Travelers who cancel at least 30 days before check-in will get back 100% of the amount they've paid. If they cancel between 14 and 30 days before check-in, they'll get back 50%. Otherwise, they won't get a refund. No refunds will be made for early departures, delayed arrival, reducing nights, weather-related reschedules, or other post-booking changes.";
  }

  if (type === CancellationPolicyType.NON_REFUNDABLE) {
    return "This reservation is non-refundable. No refunds will be made for early departures, delayed arrival, reducing nights, weather-related reschedules, or other post-booking changes.";
  }

  const hours = Math.max(
    0,
    Math.round(Number(freeCancellationHoursBeforeCheckIn ?? 0))
  );
  const windowLabel = formatCancellationWindowForGuest(hours);
  const beforePercent = clampPercent(refundPercentBeforeDeadline, 100);
  const afterPercent = clampPercent(refundPercentAfterDeadline, 0);

  const beforeText =
    beforePercent >= 100
      ? "a full refund"
      : `a ${formatRefundPercentForPolicy(beforePercent)} refund`;

  const afterText =
    afterPercent > 0
      ? `a ${formatRefundPercentForPolicy(afterPercent)} refund`
      : "no refund";

  if (hours <= 0) {
    return `After booking, eligible cancellations receive ${afterText}. No refunds will be made for early departures, delayed arrival, reducing nights, weather-related reschedules, or other post-booking changes.`;
  }

  return `Travelers who cancel at least ${windowLabel} before check-in will receive ${beforeText}. Cancellations made less than ${windowLabel} before check-in will receive ${afterText}. No refunds will be made for early departures, delayed arrival, reducing nights, weather-related reschedules, or other post-booking changes.`;
}

function buildPresetDescriptionForFields({
  type,
  freeCancellationHoursBeforeCheckIn,
  refundPercentBeforeDeadline,
  refundPercentAfterDeadline,
}: {
  type: CancellationPolicyType;
  freeCancellationHoursBeforeCheckIn: number;
  refundPercentBeforeDeadline: number;
  refundPercentAfterDeadline: number;
}) {
  if (type === CancellationPolicyType.STRICT) {
    return "Cancel at least 30 days before check-in for a 100% refund. Cancel between 14 and 30 days before check-in for a 50% refund. Otherwise, no refund applies.";
  }

  if (type === CancellationPolicyType.NON_REFUNDABLE) {
    return "This reservation is non-refundable unless the host approves an exception.";
  }

  const hours = Math.max(
    0,
    Math.round(Number(freeCancellationHoursBeforeCheckIn ?? 0))
  );
  const windowLabel = formatCancellationWindowForGuest(hours);
  const beforePercent = clampPercent(refundPercentBeforeDeadline, 100);
  const afterPercent = clampPercent(refundPercentAfterDeadline, 0);

  if (hours <= 0) {
    return `After booking, eligible cancellations receive a ${formatRefundPercentForPolicy(
      afterPercent
    )} refund.`;
  }

  return `Cancel at least ${windowLabel} before check-in for a ${formatRefundPercentForPolicy(
    beforePercent
  )} refund. Cancel less than ${windowLabel} before check-in for a ${formatRefundPercentForPolicy(
    afterPercent
  )} refund.`;
}

function buildDefaultNonRefundableScenarios(): CancellationNonRefundableScenario[] {
  return [
    "EARLY_DEPARTURE",
    "DELAYED_ARRIVAL",
    "REDUCED_NIGHTS",
    "WEATHER_RE_SCHEDULE",
    "OTHER",
  ];
}

function buildDefaultCancellationPolicySnapshot(): CancellationPolicySnapshot {
  const presetDefaults = getPolicyPresetDefaults(CancellationPolicyType.FLEXIBLE);

  return {
    policyId: null,
    name: presetDefaults.name,
    type: CancellationPolicyType.FLEXIBLE,
    source: "PIN_GO_DEFAULT",
    guestSelfCancellationEnabled: true,
    autoRefundEligibleCancellations: true,
    requireHostApprovalOutsidePolicy: true,
    freeCancellationHoursBeforeCheckIn:
      presetDefaults.freeCancellationHoursBeforeCheckIn,
    refundBasis: CancellationRefundBasis.TOTAL_AMOUNT,
    refundPercentBeforeDeadline:
      presetDefaults.refundPercentBeforeDeadline,
    refundPercentAfterDeadline:
      presetDefaults.refundPercentAfterDeadline,
    refundRules: presetDefaults.refundRules,
    nonRefundableScenarios: presetDefaults.nonRefundableScenarios,
    guestFacingSummary: presetDefaults.guestFacingSummary,
    cleaningFeeRefundable: true,
    amenitiesRefundable: true,
    taxesRefundable: true,
    nonRefundableDiscountPercent: null,
    description: presetDefaults.description,
    snapshotAt: new Date().toISOString(),
  };
}

function toCancellationPolicySnapshot(policy: any): CancellationPolicySnapshot {
  if (!policy) {
    return buildDefaultCancellationPolicySnapshot();
  }

  const type = isCancellationPolicyType(policy.type)
    ? policy.type
    : CancellationPolicyType.FLEXIBLE;

  const presetDefaults = getPolicyPresetDefaults(type);
  const isCustomPolicy = isCustomCancellationPolicyType(type);
  const isFixedPresetPolicy = isFixedPresetCancellationPolicyType(type);

  const freeCancellationHoursBeforeCheckIn = isFixedPresetPolicy
    ? presetDefaults.freeCancellationHoursBeforeCheckIn
    : Math.max(
        0,
        Math.round(
          Number(
            policy.freeCancellationHoursBeforeCheckIn ??
              presetDefaults.freeCancellationHoursBeforeCheckIn
          )
        )
      );

  const refundPercentBeforeDeadline = isCustomPolicy
    ? clampPercent(
        policy.refundPercentBeforeDeadline,
        presetDefaults.refundPercentBeforeDeadline
      )
    : presetDefaults.refundPercentBeforeDeadline;

  const refundPercentAfterDeadline = isCustomPolicy
    ? clampPercent(
        policy.refundPercentAfterDeadline,
        presetDefaults.refundPercentAfterDeadline
      )
    : presetDefaults.refundPercentAfterDeadline;

  const storedRefundRules = normalizeRefundRules(policy.refundRules, []);
  const refundRules = isCustomPolicy
    ? storedRefundRules.length > 0
      ? storedRefundRules
      : presetDefaults.refundRules
    : buildPresetRefundRulesForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      });

  const storedNonRefundableScenarios = normalizeNonRefundableScenarios(
    policy.nonRefundableScenarios
  );
  const nonRefundableScenarios = isCustomPolicy
    ? storedNonRefundableScenarios
    : presetDefaults.nonRefundableScenarios;

  const guestFacingSummary = isCustomPolicy
    ? normalizeDescription(policy.guestFacingSummary) ??
      presetDefaults.guestFacingSummary
    : buildPresetGuestFacingSummaryForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      });

  const description = isCustomPolicy
    ? normalizeDescription(policy.description) ?? presetDefaults.description
    : buildPresetDescriptionForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      });

  return {
    policyId: policy.id,
    name: isCustomPolicy
      ? normalizePolicyName(policy.name, presetDefaults.name)
      : presetDefaults.name,
    type,
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
    freeCancellationHoursBeforeCheckIn,
    refundBasis: isCancellationRefundBasis(policy.refundBasis)
      ? policy.refundBasis
      : CancellationRefundBasis.TOTAL_AMOUNT,
    refundPercentBeforeDeadline,
    refundPercentAfterDeadline,
    refundRules,
    nonRefundableScenarios,
    guestFacingSummary,
    cleaningFeeRefundable: Boolean(policy.cleaningFeeRefundable),
    amenitiesRefundable: Boolean(policy.amenitiesRefundable),
    taxesRefundable: Boolean(policy.taxesRefundable),
    nonRefundableDiscountPercent:
      policy.nonRefundableDiscountPercent === null ||
      policy.nonRefundableDiscountPercent === undefined
        ? null
        : clampPercent(policy.nonRefundableDiscountPercent),
    description,
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
    rr: snapshot.refundRules.map((rule) => ({
    h: rule.minHoursBeforeCheckIn,
    p: rule.refundPercent,
    l: rule.label.slice(0, 60),
  })),
  nrs: snapshot.nonRefundableScenarios,
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

    const type = isCancellationPolicyType(record.t) ? record.t : fallback.type;
    const presetDefaults = getPolicyPresetDefaults(type);
    const isCustomPolicy = isCustomCancellationPolicyType(type);
    const isFixedPresetPolicy = isFixedPresetCancellationPolicyType(type);

    const freeCancellationHoursBeforeCheckIn = isFixedPresetPolicy
      ? presetDefaults.freeCancellationHoursBeforeCheckIn
      : Math.max(
          0,
          Math.round(
            toNumber(
              record.hrs,
              presetDefaults.freeCancellationHoursBeforeCheckIn
            )
          )
        );

    const refundPercentBeforeDeadline = isCustomPolicy
      ? clampPercent(record.rb, presetDefaults.refundPercentBeforeDeadline)
      : presetDefaults.refundPercentBeforeDeadline;

    const refundPercentAfterDeadline = isCustomPolicy
      ? clampPercent(record.ra, presetDefaults.refundPercentAfterDeadline)
      : presetDefaults.refundPercentAfterDeadline;

    const storedRefundRules = normalizeRefundRules(
      Array.isArray(record.rr)
        ? record.rr.map((rule: any) => ({
            minHoursBeforeCheckIn: rule.h,
            refundPercent: rule.p,
            label: rule.l,
          }))
        : [],
      []
    );

    const refundRules = isCustomPolicy
      ? storedRefundRules.length > 0
        ? storedRefundRules
        : presetDefaults.refundRules
      : buildPresetRefundRulesForFields({
          type,
          freeCancellationHoursBeforeCheckIn,
          refundPercentBeforeDeadline,
          refundPercentAfterDeadline,
        });

    const storedNonRefundableScenarios = normalizeNonRefundableScenarios(
      record.nrs
    );

    const nonRefundableScenarios = isCustomPolicy
      ? storedNonRefundableScenarios
      : storedNonRefundableScenarios.length > 0
      ? storedNonRefundableScenarios
      : presetDefaults.nonRefundableScenarios;

    const guestFacingSummary = isCustomPolicy
      ? null
      : buildPresetGuestFacingSummaryForFields({
          type,
          freeCancellationHoursBeforeCheckIn,
          refundPercentBeforeDeadline,
          refundPercentAfterDeadline,
        });

    const description = isCustomPolicy
      ? null
      : buildPresetDescriptionForFields({
          type,
          freeCancellationHoursBeforeCheckIn,
          refundPercentBeforeDeadline,
          refundPercentAfterDeadline,
        });

    return {
      policyId: toOptionalString(record.id),
      name: isCustomPolicy
        ? toOptionalString(record.n) || presetDefaults.name
        : presetDefaults.name,
      type,
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
      freeCancellationHoursBeforeCheckIn,
      refundBasis: isCancellationRefundBasis(record.b)
        ? record.b
        : fallback.refundBasis,
      refundPercentBeforeDeadline,
      refundPercentAfterDeadline,
      refundRules,
      nonRefundableScenarios,
      guestFacingSummary,
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
      description,
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

function getPolicyPresetDefaults(type: CancellationPolicyType): {
  name: string;
  freeCancellationHoursBeforeCheckIn: number;
  refundPercentBeforeDeadline: number;
  refundPercentAfterDeadline: number;
  refundRules: CancellationRefundRule[];
  nonRefundableScenarios: CancellationNonRefundableScenario[];
  guestFacingSummary: string | null;
  description: string | null;
} {
  if (type === CancellationPolicyType.MODERATE) {
    const freeCancellationHoursBeforeCheckIn = 120;
    const refundPercentBeforeDeadline = 100;
    const refundPercentAfterDeadline = 50;

    return {
      name: "Moderate",
      freeCancellationHoursBeforeCheckIn,
      refundPercentBeforeDeadline,
      refundPercentAfterDeadline,
      refundRules: buildPresetRefundRulesForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
      nonRefundableScenarios: buildDefaultNonRefundableScenarios(),
      guestFacingSummary: buildPresetGuestFacingSummaryForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
      description: buildPresetDescriptionForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
    };
  }

  if (type === CancellationPolicyType.FIRM) {
    const freeCancellationHoursBeforeCheckIn = 168;
    const refundPercentBeforeDeadline = 100;
    const refundPercentAfterDeadline = 50;

    return {
      name: "Firm",
      freeCancellationHoursBeforeCheckIn,
      refundPercentBeforeDeadline,
      refundPercentAfterDeadline,
      refundRules: buildPresetRefundRulesForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
      nonRefundableScenarios: buildDefaultNonRefundableScenarios(),
      guestFacingSummary: buildPresetGuestFacingSummaryForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
      description: buildPresetDescriptionForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
    };
  }

  if (type === CancellationPolicyType.STRICT) {
    const freeCancellationHoursBeforeCheckIn = 720;
    const refundPercentBeforeDeadline = 100;
    const refundPercentAfterDeadline = 0;

    return {
      name: "Strict",
      freeCancellationHoursBeforeCheckIn,
      refundPercentBeforeDeadline,
      refundPercentAfterDeadline,
      refundRules: buildStrictTieredRefundRules(),
      nonRefundableScenarios: buildDefaultNonRefundableScenarios(),
      guestFacingSummary: buildPresetGuestFacingSummaryForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
      description: buildPresetDescriptionForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
    };
  }

  if (type === CancellationPolicyType.NON_REFUNDABLE) {
    const freeCancellationHoursBeforeCheckIn = 0;
    const refundPercentBeforeDeadline = 0;
    const refundPercentAfterDeadline = 0;

    return {
      name: "Non-refundable",
      freeCancellationHoursBeforeCheckIn,
      refundPercentBeforeDeadline,
      refundPercentAfterDeadline,
      refundRules: buildNonRefundableRefundRules(),
      nonRefundableScenarios: buildDefaultNonRefundableScenarios(),
      guestFacingSummary: buildPresetGuestFacingSummaryForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
      description: buildPresetDescriptionForFields({
        type,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      }),
    };
  }

  if (type === CancellationPolicyType.CUSTOM) {
    return {
      name: "Custom",
      freeCancellationHoursBeforeCheckIn: 720,
      refundPercentBeforeDeadline: 100,
      refundPercentAfterDeadline: 0,
      refundRules: buildStrictTieredRefundRules(),
      nonRefundableScenarios: buildDefaultNonRefundableScenarios(),
      guestFacingSummary:
        "Custom cancellation policy configured by the host. Review the refund windows below before completing your reservation.",
      description: "Custom cancellation policy configured by the host.",
    };
  }

  const freeCancellationHoursBeforeCheckIn = 168;
  const refundPercentBeforeDeadline = 100;
  const refundPercentAfterDeadline = 0;
  const fallbackType = CancellationPolicyType.FLEXIBLE;

  return {
    name: "Flexible",
    freeCancellationHoursBeforeCheckIn,
    refundPercentBeforeDeadline,
    refundPercentAfterDeadline,
    refundRules: buildPresetRefundRulesForFields({
      type: fallbackType,
      freeCancellationHoursBeforeCheckIn,
      refundPercentBeforeDeadline,
      refundPercentAfterDeadline,
    }),
    nonRefundableScenarios: buildDefaultNonRefundableScenarios(),
    guestFacingSummary: buildPresetGuestFacingSummaryForFields({
      type: fallbackType,
      freeCancellationHoursBeforeCheckIn,
      refundPercentBeforeDeadline,
      refundPercentAfterDeadline,
    }),
    description: buildPresetDescriptionForFields({
      type: fallbackType,
      freeCancellationHoursBeforeCheckIn,
      refundPercentBeforeDeadline,
      refundPercentAfterDeadline,
    }),
  };
}

function serializeDashboardPolicy(policy: any) {
  if (!policy) return null;

  const snapshot = toCancellationPolicySnapshot(policy);

  return {
    id: policy.id,
    propertyId: policy.propertyId,
    name: snapshot.name,
    type: snapshot.type,
    source: snapshot.source,
    isActive: policy.isActive,
    guestSelfCancellationEnabled: snapshot.guestSelfCancellationEnabled,
    autoRefundEligibleCancellations:
      snapshot.autoRefundEligibleCancellations,
    requireHostApprovalOutsidePolicy:
      snapshot.requireHostApprovalOutsidePolicy,
    freeCancellationHoursBeforeCheckIn:
      snapshot.freeCancellationHoursBeforeCheckIn,
    refundBasis: snapshot.refundBasis,
    refundPercentBeforeDeadline: snapshot.refundPercentBeforeDeadline,
    refundPercentAfterDeadline: snapshot.refundPercentAfterDeadline,
    refundRules: snapshot.refundRules,
    nonRefundableScenarios: snapshot.nonRefundableScenarios,
    guestFacingSummary: snapshot.guestFacingSummary,
    cleaningFeeRefundable: snapshot.cleaningFeeRefundable,
    amenitiesRefundable: snapshot.amenitiesRefundable,
    taxesRefundable: snapshot.taxesRefundable,
    nonRefundableDiscountPercent: snapshot.nonRefundableDiscountPercent,
    description: snapshot.description,
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

function toCancellationPolicyRendererModel(
  snapshot: CancellationPolicySnapshot
): CancellationPolicyModel {
  return {
    type: snapshot.type,
    refundBasis: snapshot.refundBasis,
    refundRules: snapshot.refundRules.map((rule) => ({
      minHoursBeforeCheckIn: rule.minHoursBeforeCheckIn,
      refundPercent: rule.refundPercent,
    })),
    nonRefundableScenarios: [...snapshot.nonRefundableScenarios],
    guestSelfCancellationEnabled:
      snapshot.guestSelfCancellationEnabled,
    autoRefundEligibleCancellations:
      snapshot.autoRefundEligibleCancellations,
    requireHostApprovalOutsidePolicy:
      snapshot.requireHostApprovalOutsidePolicy,
    cleaningFeeRefundable: snapshot.cleaningFeeRefundable,
    amenitiesRefundable: snapshot.amenitiesRefundable,
    taxesRefundable: snapshot.taxesRefundable,
  };
}

export function renderCancellationPolicySnapshot({
  snapshot,
  preferredLanguage,
  checkIn,
}: {
  snapshot: CancellationPolicySnapshot;
  preferredLanguage?: string | null;
  checkIn?: Date | string | null;
}): RenderedCancellationPolicy {
  return renderCancellationPolicy({
    policy: toCancellationPolicyRendererModel(snapshot),
    preferredLanguage,
    checkIn,
  });
}

export function buildGuestCancellationTermsText(
  policy: CancellationPolicySnapshot,
  preferredLanguage?: string | null
) {
  const renderedPolicy = renderCancellationPolicySnapshot({
    snapshot: policy,
    preferredLanguage,
  });

  return [
    renderedPolicy.acceptanceText,
    renderedPolicy.refundBasisDisclosure,
    renderedPolicy.feeDisclosure,
  ]
    .filter(Boolean)
    .join(" ");
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

  const hoursBeforeCheckIn =
  (checkInMs - requestedAtMs) / (1000 * 60 * 60);

  const usesTieredRules = snapshot.refundRules.length > 0;

  const matchedRefundRule = usesTieredRules
    ? getMatchedRefundRule({
        rules: snapshot.refundRules,
        hoursBeforeCheckIn,
      })
    : null;

  const primaryFreeCancellationHours =
    getPrimaryFreeCancellationHours(snapshot);

  const deadline = new Date(
    checkInMs - primaryFreeCancellationHours * 60 * 60 * 1000
  );

  const beforeDeadline = requestedAtMs <= deadline.getTime();

  const refundPercent = usesTieredRules
    ? matchedRefundRule?.refundPercent ?? 0
    : beforeDeadline
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

    const outsidePolicy = usesTieredRules ? !matchedRefundRule : !beforeDeadline;

  const requiresHostApproval =
    !snapshot.guestSelfCancellationEnabled ||
    (outsidePolicy && snapshot.requireHostApprovalOutsidePolicy);

  const eligibleForGuestSelfCancellation =
    snapshot.guestSelfCancellationEnabled && !requiresHostApproval;

  const eligibleForAutoRefund =
    eligibleForGuestSelfCancellation &&
    snapshot.autoRefundEligibleCancellations &&
    refundAmountCents > 0;

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

    // Cancellation Policy Engine V1.1
    usesTieredRules,
    matchedRefundRule,
    nonRefundableScenarios: snapshot.nonRefundableScenarios,
    guestFacingSummary: snapshot.guestFacingSummary,

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
  const isCustomPolicy = isCustomCancellationPolicyType(requestedType);
  const isFixedPresetPolicy = isFixedPresetCancellationPolicyType(
    requestedType
  );

  const freeCancellationHoursBeforeCheckIn = isFixedPresetPolicy
    ? presetDefaults.freeCancellationHoursBeforeCheckIn
    : normalizeHours(
        input.freeCancellationHoursBeforeCheckIn,
        existingPolicy?.freeCancellationHoursBeforeCheckIn ??
          presetDefaults.freeCancellationHoursBeforeCheckIn
      );

  const refundBasis = isRefundBasis(input.refundBasis)
    ? input.refundBasis
    : existingPolicy?.refundBasis ?? CancellationRefundBasis.TOTAL_AMOUNT;

  const refundPercentBeforeDeadline = isCustomPolicy
    ? clampPercent(
        input.refundPercentBeforeDeadline,
        existingPolicy
          ? Number(existingPolicy.refundPercentBeforeDeadline)
          : presetDefaults.refundPercentBeforeDeadline
      )
    : presetDefaults.refundPercentBeforeDeadline;

  const refundPercentAfterDeadline = isCustomPolicy
    ? clampPercent(
        input.refundPercentAfterDeadline,
        existingPolicy
          ? Number(existingPolicy.refundPercentAfterDeadline)
          : presetDefaults.refundPercentAfterDeadline
      )
    : presetDefaults.refundPercentAfterDeadline;

  const existingRefundRules = existingPolicy
    ? normalizeRefundRules(existingPolicy.refundRules, [])
    : [];

  const refundRules = isCustomPolicy
    ? input.refundRules !== undefined
      ? normalizeRefundRules(input.refundRules, presetDefaults.refundRules)
      : existingRefundRules.length > 0
      ? existingRefundRules
      : presetDefaults.refundRules
    : buildPresetRefundRulesForFields({
        type: requestedType,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      });

  const existingNonRefundableScenarios = existingPolicy
    ? normalizeNonRefundableScenarios(existingPolicy.nonRefundableScenarios)
    : [];

  const nonRefundableScenarios = isCustomPolicy
    ? input.nonRefundableScenarios !== undefined
      ? normalizeNonRefundableScenarios(input.nonRefundableScenarios)
      : existingNonRefundableScenarios.length > 0
      ? existingNonRefundableScenarios
      : presetDefaults.nonRefundableScenarios
    : presetDefaults.nonRefundableScenarios;

  const guestFacingSummary = isCustomPolicy
    ? normalizeDescription(
        input.guestFacingSummary ??
          existingPolicy?.guestFacingSummary ??
          presetDefaults.guestFacingSummary
      )
    : buildPresetGuestFacingSummaryForFields({
        type: requestedType,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      });

  const description = isCustomPolicy
    ? normalizeDescription(
        input.description ?? existingPolicy?.description ?? presetDefaults.description
      )
    : buildPresetDescriptionForFields({
        type: requestedType,
        freeCancellationHoursBeforeCheckIn,
        refundPercentBeforeDeadline,
        refundPercentAfterDeadline,
      });

  const data = {
    propertyId: property.id,
    name: isCustomPolicy
      ? normalizePolicyName(
          input.name,
          existingPolicy?.name ?? presetDefaults.name
        )
      : presetDefaults.name,
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

    freeCancellationHoursBeforeCheckIn,
    refundBasis,
    refundPercentBeforeDeadline,
    refundPercentAfterDeadline,
    refundRules: refundRules as any,
    nonRefundableScenarios: nonRefundableScenarios as any,
    guestFacingSummary,

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

    description,
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
