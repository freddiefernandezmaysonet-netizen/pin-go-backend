import { createHash } from "node:crypto";

import { calculateChannexAriCanonicalJsonIntegrity } from "../pms/outbound/channex-ari-canonical-json.policy";
import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
} from "../pms/outbound/channex-ari-lifecycle.policy";

export const CHANNEX_CORRELATED_FULL_SYNC_EVIDENCE_TYPE =
  "CHANNEX_CORRELATED_FULL_SYNC_ACCEPTED" as const;

export const CHANNEX_AIRBNB_TRANSPORT_POLICY_VERSION =
  "channex_airbnb_transport_v1" as const;

export const CHANNEX_AIRBNB_TRANSPORT_SEMANTIC_SCOPE =
  "TECHNICAL_CHANNEL_CONNECTION" as const;

export const CHANNEX_AIRBNB_TRANSPORT_DOES_NOT_ATTEST = [
  "AIRBNB_PAYMENT_CONFIGURATION",
  "AIRBNB_TAX_CONFIGURATION",
  "AIRBNB_LISTING_CONTENT",
  "AIRBNB_ARI_DOWNSTREAM_ACCEPTANCE",
] as const;

export type ChannexAriPropertyStateEvidence = {
  organizationId: string;
  propertyId: string;
  lastFullSyncRequestedAt: Date | null;
  lastFullSyncCompletedAt: Date | null;
};

export type ChannexCorrelatedFullSyncQualificationReason =
  | "QUALIFIED"
  | "EXPECTED_SCOPE_INVALID"
  | "PROPERTY_STATE_MISSING"
  | "PROPERTY_STATE_SCOPE_MISMATCH"
  | "CHANNEL_ACTIVATION_EVIDENCE_MISSING"
  | "CHANNEL_ACTIVATION_EVIDENCE_INVALID"
  | "LIFECYCLE_EVIDENCE_MISSING"
  | "LIFECYCLE_EVIDENCE_INVALID"
  | "MAPPING_CHANGE_EVIDENCE_MISSING"
  | "MAPPING_CHANGE_EVIDENCE_INVALID"
  | "FULL_SYNC_REQUEST_EVIDENCE_MISSING"
  | "FULL_SYNC_REQUEST_EVIDENCE_INVALID"
  | "FULL_SYNC_COMPLETION_EVIDENCE_MISSING"
  | "FULL_SYNC_COMPLETION_EVIDENCE_INVALID"
  | "FULL_SYNC_COMPLETION_PREDATES_REQUEST"
  | "FULL_SYNC_REQUEST_PREDATES_FRONTIER"
  | "FULL_SYNC_COMPLETION_PREDATES_FRONTIER"
  | "FULL_SYNC_MAPPING_EVIDENCE_INVALID"
  | "FULL_SYNC_CORRELATION_EVIDENCE_MISSING"
  | "FULL_SYNC_CORRELATION_EVIDENCE_AMBIGUOUS"
  | "FULL_SYNC_CORRELATION_PAIR_INVALID"
  | "FULL_SYNC_CORRELATION_STATE_MISMATCH"
  | "FULL_SYNC_CORRELATION_MAPPING_MISMATCH"
  | "FULL_SYNC_CORRELATION_PAYLOAD_MISMATCH"
  | "FULL_SYNC_HORIZON_EVIDENCE_INVALID"
  | "FULL_SYNC_HORIZON_EVIDENCE_MISMATCH"
  | "FULL_SYNC_PAYLOAD_SHAPE_INVALID"
  | "FULL_SYNC_PAYLOAD_HORIZON_INVALID"
  | "FULL_SYNC_PAYLOAD_INTEGRITY_INVALID";

export type ChannexCorrelatedFullSyncOutboxEvidence = {
  id: string;
  organizationId: string;
  propertyId: string;
  provider: string;
  messageKind: string;
  syncMode: string;
  scope: string;
  status: string;
  correlationId: string | null;
  dateFrom: Date | null;
  dateToExclusive: Date | null;
  dateKeys: string[];
  createdAt: Date;
  deliveryId: string | null;
  delivery: {
    id: string;
    organizationId: string;
    propertyId: string;
    connectionId: string;
    listingId: string;
    messageKind: string;
    syncMode: string;
    scope: string;
    dateFrom: Date | null;
    dateToExclusive: Date | null;
    dateKeys: string[];
    status: string;
    sentAt: Date | null;
    payload: unknown;
    payloadHash: string;
    payloadValueCount: number;
    payloadBytes: number;
  } | null;
};

export type ChannexCorrelatedFullSyncQualification = {
  evidenceType: typeof CHANNEX_CORRELATED_FULL_SYNC_EVIDENCE_TYPE;
  qualified: boolean;
  reason: ChannexCorrelatedFullSyncQualificationReason;
  confirmedAt: Date | null;
  requestedAt: Date | null;
  completedAt: Date | null;
  frontierAt: Date | null;
  correlationId: string | null;
  mappingFingerprint: string | null;
  otaAcceptanceVerified: false;
};

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validDate(value: unknown): Date | null {
  if (!(value instanceof Date)) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function unqualifiedFullSync(
  reason: ChannexCorrelatedFullSyncQualificationReason,
  evidence: {
    requestedAt?: Date | null;
    completedAt?: Date | null;
    frontierAt?: Date | null;
  } = {},
): ChannexCorrelatedFullSyncQualification {
  return {
    evidenceType: CHANNEX_CORRELATED_FULL_SYNC_EVIDENCE_TYPE,
    qualified: false,
    reason,
    confirmedAt: null,
    requestedAt: evidence.requestedAt ?? null,
    completedAt: evidence.completedAt ?? null,
    frontierAt: evidence.frontierAt ?? null,
    correlationId: null,
    mappingFingerprint: null,
    otaAcceptanceVerified: false,
  };
}

type FullSyncMappingIdentity = {
  connectionId: string;
  listingId: string;
  externalPropertyId: string;
  externalRoomTypeId: string;
  externalRatePlanId: string;
};

function fullSyncMappingIdentity(input: {
  expectedConnectionId: string;
  expectedListingId: string;
  expectedExternalPropertyId: string;
  expectedExternalRoomTypeId: string;
  expectedExternalRatePlanId: string;
}): FullSyncMappingIdentity | null {
  const mapping = {
    connectionId: normalizedText(input.expectedConnectionId),
    listingId: normalizedText(input.expectedListingId),
    externalPropertyId: normalizedText(input.expectedExternalPropertyId),
    externalRoomTypeId: normalizedText(input.expectedExternalRoomTypeId),
    externalRatePlanId: normalizedText(input.expectedExternalRatePlanId),
  };
  return Object.values(mapping).every(Boolean) ? mapping : null;
}

function mappingFingerprint(mapping: FullSyncMappingIdentity): string {
  return createHash("sha256")
    .update(
      [
        mapping.connectionId,
        mapping.listingId,
        mapping.externalPropertyId,
        mapping.externalRoomTypeId,
        mapping.externalRatePlanId,
      ].join("\u0000"),
    )
    .digest("hex");
}

type FullSyncPayloadValidation =
  | { ok: true; coveredDateKeys: string[] }
  | {
      ok: false;
      reason:
        | "FULL_SYNC_CORRELATION_PAYLOAD_MISMATCH"
        | "FULL_SYNC_PAYLOAD_SHAPE_INVALID"
        | "FULL_SYNC_PAYLOAD_HORIZON_INVALID"
        | "FULL_SYNC_PAYLOAD_INTEGRITY_INVALID";
    };

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  );
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function strictDateKey(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function databaseDateKey(value: unknown): string | null {
  const date = validDate(value);
  if (
    !date ||
    date.getUTCHours() !== 0 ||
    date.getUTCMinutes() !== 0 ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function expandPayloadDateEvidence(
  value: Record<string, unknown>,
): string[] | null {
  const hasDate = Object.prototype.hasOwnProperty.call(value, "date");
  const hasDateFrom = Object.prototype.hasOwnProperty.call(value, "date_from");
  const hasDateTo = Object.prototype.hasOwnProperty.call(value, "date_to");
  if (hasDate && !hasDateFrom && !hasDateTo) {
    const date = strictDateKey(value.date);
    return date ? [date] : null;
  }
  if (hasDate || !hasDateFrom || !hasDateTo) return null;

  const dateFrom = strictDateKey(value.date_from);
  const dateTo = strictDateKey(value.date_to);
  if (!dateFrom || !dateTo || dateTo < dateFrom) return null;

  const dates: string[] = [];
  for (
    let date = dateFrom;
    date <= dateTo && dates.length <= CHANNEX_ARI_FULL_SYNC_DAYS;
    date = addUtcDays(date, 1)
  ) {
    dates.push(date);
  }
  return dates.length > CHANNEX_ARI_FULL_SYNC_DAYS ? null : dates;
}

function positiveRate(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      value === value.trim() &&
      /^\d+(?:\.\d+)?$/.test(value) &&
      /[1-9]/.test(value)
    );
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateFullSyncPayload(args: {
  messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
  payload: unknown;
  payloadHash: unknown;
  payloadValueCount: unknown;
  payloadBytes: unknown;
  expectedDateKeys: string[];
  mapping: FullSyncMappingIdentity;
}): FullSyncPayloadValidation {
  const payload = record(args.payload);
  if (
    !payload ||
    !exactKeys(payload, ["values"]) ||
    !Array.isArray(payload.values) ||
    payload.values.length === 0
  ) {
    return { ok: false, reason: "FULL_SYNC_PAYLOAD_SHAPE_INVALID" };
  }

  if (
    !Number.isSafeInteger(args.payloadValueCount) ||
    (args.payloadValueCount as number) <= 0 ||
    args.payloadValueCount !== payload.values.length ||
    !Number.isSafeInteger(args.payloadBytes) ||
    (args.payloadBytes as number) <= 0 ||
    typeof args.payloadHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(args.payloadHash)
  ) {
    return { ok: false, reason: "FULL_SYNC_PAYLOAD_INTEGRITY_INVALID" };
  }

  const coveredDateKeys: string[] = [];
  for (const value of payload.values) {
    const item = record(value);
    if (
      !item ||
      normalizedText(item.property_id) !== args.mapping.externalPropertyId
    ) {
      return { ok: false, reason: "FULL_SYNC_CORRELATION_PAYLOAD_MISMATCH" };
    }

    const hasDate = Object.prototype.hasOwnProperty.call(item, "date");
    const dateKeys = hasDate ? ["date"] : ["date_from", "date_to"];
    if (args.messageKind === "AVAILABILITY") {
      if (
        !exactKeys(item, [
          "property_id",
          "room_type_id",
          ...dateKeys,
          "availability",
        ])
      ) {
        return { ok: false, reason: "FULL_SYNC_PAYLOAD_SHAPE_INVALID" };
      }
      if (
        normalizedText(item.room_type_id) !== args.mapping.externalRoomTypeId
      ) {
        return {
          ok: false,
          reason: "FULL_SYNC_CORRELATION_PAYLOAD_MISMATCH",
        };
      }
      if (item.availability !== 0 && item.availability !== 1) {
        return { ok: false, reason: "FULL_SYNC_PAYLOAD_SHAPE_INVALID" };
      }
    } else {
      if (
        !exactKeys(item, [
          "property_id",
          "rate_plan_id",
          ...dateKeys,
          "rate",
          "min_stay_arrival",
          "min_stay_through",
          "max_stay",
        ])
      ) {
        return { ok: false, reason: "FULL_SYNC_PAYLOAD_SHAPE_INVALID" };
      }
      if (
        normalizedText(item.rate_plan_id) !== args.mapping.externalRatePlanId
      ) {
        return {
          ok: false,
          reason: "FULL_SYNC_CORRELATION_PAYLOAD_MISMATCH",
        };
      }
      if (
        !positiveRate(item.rate) ||
        !positiveInteger(item.min_stay_arrival) ||
        !positiveInteger(item.min_stay_through) ||
        !nonNegativeInteger(item.max_stay) ||
        (item.max_stay > 0 &&
          (item.max_stay < item.min_stay_arrival ||
            item.max_stay < item.min_stay_through))
      ) {
        return { ok: false, reason: "FULL_SYNC_PAYLOAD_SHAPE_INVALID" };
      }
    }

    const dates = expandPayloadDateEvidence(item);
    if (!dates) {
      return { ok: false, reason: "FULL_SYNC_PAYLOAD_HORIZON_INVALID" };
    }
    coveredDateKeys.push(...dates);
    if (coveredDateKeys.length > CHANNEX_ARI_FULL_SYNC_DAYS) {
      return { ok: false, reason: "FULL_SYNC_PAYLOAD_HORIZON_INVALID" };
    }
  }

  if (
    coveredDateKeys.length !== args.expectedDateKeys.length ||
    coveredDateKeys.some(
      (dateKey, index) => dateKey !== args.expectedDateKeys[index],
    )
  ) {
    return { ok: false, reason: "FULL_SYNC_PAYLOAD_HORIZON_INVALID" };
  }

  try {
    const integrity = calculateChannexAriCanonicalJsonIntegrity(payload);
    if (
      integrity.payloadHash !== args.payloadHash ||
      integrity.payloadBytes !== args.payloadBytes
    ) {
      return { ok: false, reason: "FULL_SYNC_PAYLOAD_INTEGRITY_INVALID" };
    }
  } catch {
    return { ok: false, reason: "FULL_SYNC_PAYLOAD_INTEGRITY_INVALID" };
  }

  return { ok: true, coveredDateKeys };
}

export function qualifyChannexCorrelatedFullSyncEvidence(input: {
  expectedOrganizationId: string;
  expectedPropertyId: string;
  expectedConnectionId: string;
  expectedListingId: string;
  expectedExternalPropertyId: string;
  expectedExternalRoomTypeId: string;
  expectedExternalRatePlanId: string;
  state: ChannexAriPropertyStateEvidence | null;
  outboxEvidence: readonly ChannexCorrelatedFullSyncOutboxEvidence[];
  lastChannelActivatedAt: Date | null;
  lastLifecycleOccurredAt: Date | null;
  mappingLastChangedAt: Date | null;
}): ChannexCorrelatedFullSyncQualification {
  const expectedOrganizationId = normalizedText(input.expectedOrganizationId);
  const expectedPropertyId = normalizedText(input.expectedPropertyId);

  if (!expectedOrganizationId || !expectedPropertyId) {
    return unqualifiedFullSync("EXPECTED_SCOPE_INVALID");
  }

  if (!input.state) {
    return unqualifiedFullSync("PROPERTY_STATE_MISSING");
  }

  if (
    normalizedText(input.state.organizationId) !== expectedOrganizationId ||
    normalizedText(input.state.propertyId) !== expectedPropertyId
  ) {
    return unqualifiedFullSync("PROPERTY_STATE_SCOPE_MISMATCH");
  }

  if (!input.lastChannelActivatedAt) {
    return unqualifiedFullSync("CHANNEL_ACTIVATION_EVIDENCE_MISSING");
  }
  const lastChannelActivatedAt = validDate(input.lastChannelActivatedAt);
  if (!lastChannelActivatedAt) {
    return unqualifiedFullSync("CHANNEL_ACTIVATION_EVIDENCE_INVALID");
  }

  if (!input.lastLifecycleOccurredAt) {
    return unqualifiedFullSync("LIFECYCLE_EVIDENCE_MISSING");
  }
  const lastLifecycleOccurredAt = validDate(input.lastLifecycleOccurredAt);
  if (!lastLifecycleOccurredAt) {
    return unqualifiedFullSync("LIFECYCLE_EVIDENCE_INVALID");
  }

  if (!input.mappingLastChangedAt) {
    return unqualifiedFullSync("MAPPING_CHANGE_EVIDENCE_MISSING");
  }
  const mappingLastChangedAt = validDate(input.mappingLastChangedAt);
  if (!mappingLastChangedAt) {
    return unqualifiedFullSync("MAPPING_CHANGE_EVIDENCE_INVALID");
  }

  const frontierAt = new Date(
    Math.max(
      lastChannelActivatedAt.getTime(),
      lastLifecycleOccurredAt.getTime(),
      mappingLastChangedAt.getTime(),
    ),
  );

  if (!input.state.lastFullSyncRequestedAt) {
    return unqualifiedFullSync("FULL_SYNC_REQUEST_EVIDENCE_MISSING", {
      frontierAt,
    });
  }
  const requestedAt = validDate(input.state.lastFullSyncRequestedAt);
  if (!requestedAt) {
    return unqualifiedFullSync("FULL_SYNC_REQUEST_EVIDENCE_INVALID", {
      frontierAt,
    });
  }

  if (!input.state.lastFullSyncCompletedAt) {
    return unqualifiedFullSync("FULL_SYNC_COMPLETION_EVIDENCE_MISSING", {
      requestedAt,
      frontierAt,
    });
  }
  const completedAt = validDate(input.state.lastFullSyncCompletedAt);
  if (!completedAt) {
    return unqualifiedFullSync("FULL_SYNC_COMPLETION_EVIDENCE_INVALID", {
      requestedAt,
      frontierAt,
    });
  }

  if (completedAt.getTime() < requestedAt.getTime()) {
    return unqualifiedFullSync("FULL_SYNC_COMPLETION_PREDATES_REQUEST", {
      requestedAt,
      completedAt,
      frontierAt,
    });
  }

  if (completedAt.getTime() < frontierAt.getTime()) {
    return unqualifiedFullSync("FULL_SYNC_COMPLETION_PREDATES_FRONTIER", {
      requestedAt,
      completedAt,
      frontierAt,
    });
  }

  if (requestedAt.getTime() < frontierAt.getTime()) {
    return unqualifiedFullSync("FULL_SYNC_REQUEST_PREDATES_FRONTIER", {
      requestedAt,
      completedAt,
      frontierAt,
    });
  }

  const mapping = fullSyncMappingIdentity(input);
  if (!mapping) {
    return unqualifiedFullSync("FULL_SYNC_MAPPING_EVIDENCE_INVALID", {
      requestedAt,
      completedAt,
      frontierAt,
    });
  }
  if (
    !Array.isArray(input.outboxEvidence) ||
    input.outboxEvidence.length === 0
  ) {
    return unqualifiedFullSync("FULL_SYNC_CORRELATION_EVIDENCE_MISSING", {
      requestedAt,
      completedAt,
      frontierAt,
    });
  }
  if (input.outboxEvidence.length !== 2) {
    return unqualifiedFullSync("FULL_SYNC_CORRELATION_EVIDENCE_AMBIGUOUS", {
      requestedAt,
      completedAt,
      frontierAt,
    });
  }

  const correlationIds = new Set(
    input.outboxEvidence.map((row) => normalizedText(row.correlationId)),
  );
  const eventIds = new Set(
    input.outboxEvidence.map((row) => normalizedText(row.id)),
  );
  const deliveryIds = new Set(
    input.outboxEvidence.map((row) => normalizedText(row.deliveryId)),
  );
  const messageKinds = new Set(
    input.outboxEvidence.map((row) => normalizedText(row.messageKind)),
  );
  if (
    correlationIds.size !== 1 ||
    ![...correlationIds][0] ||
    eventIds.size !== 2 ||
    eventIds.has("") ||
    deliveryIds.size !== 2 ||
    deliveryIds.has("") ||
    messageKinds.size !== 2 ||
    !messageKinds.has("AVAILABILITY") ||
    !messageKinds.has("RATES_RESTRICTIONS")
  ) {
    return unqualifiedFullSync("FULL_SYNC_CORRELATION_PAIR_INVALID", {
      requestedAt,
      completedAt,
      frontierAt,
    });
  }

  const sentAtValues: Date[] = [];
  let pairDateFrom: string | null = null;
  let pairDateToExclusive: string | null = null;
  for (const row of input.outboxEvidence) {
    const createdAt = validDate(row.createdAt);
    const delivery = row.delivery;
    const sentAt = validDate(delivery?.sentAt ?? null);
    if (
      normalizedText(row.organizationId) !== expectedOrganizationId ||
      normalizedText(row.propertyId) !== expectedPropertyId ||
      normalizedText(row.provider) !== "CHANNEX" ||
      normalizedText(row.syncMode) !== "FULL" ||
      normalizedText(row.scope) !== "FULL_HORIZON" ||
      normalizedText(row.status) !== "MERGED" ||
      !createdAt ||
      createdAt.getTime() < requestedAt.getTime() ||
      createdAt.getTime() > completedAt.getTime() ||
      !delivery ||
      normalizedText(delivery.id) !== normalizedText(row.deliveryId) ||
      normalizedText(delivery.organizationId) !== expectedOrganizationId ||
      normalizedText(delivery.propertyId) !== expectedPropertyId ||
      normalizedText(delivery.messageKind) !==
        normalizedText(row.messageKind) ||
      normalizedText(delivery.syncMode) !== "FULL" ||
      normalizedText(delivery.scope) !== "FULL_HORIZON" ||
      normalizedText(delivery.status) !== "SENT" ||
      !sentAt ||
      sentAt.getTime() < requestedAt.getTime() ||
      sentAt.getTime() > completedAt.getTime()
    ) {
      return unqualifiedFullSync("FULL_SYNC_CORRELATION_STATE_MISMATCH", {
        requestedAt,
        completedAt,
        frontierAt,
      });
    }

    const rowDateFrom = databaseDateKey(row.dateFrom);
    const rowDateToExclusive = databaseDateKey(row.dateToExclusive);
    const deliveryDateFrom = databaseDateKey(delivery.dateFrom);
    const deliveryDateToExclusive = databaseDateKey(delivery.dateToExclusive);
    if (
      !rowDateFrom ||
      !rowDateToExclusive ||
      !deliveryDateFrom ||
      !deliveryDateToExclusive ||
      !Array.isArray(row.dateKeys) ||
      row.dateKeys.length !== 0 ||
      !Array.isArray(delivery.dateKeys) ||
      delivery.dateKeys.length !== 0 ||
      addUtcDays(rowDateFrom, CHANNEX_ARI_FULL_SYNC_DAYS) !== rowDateToExclusive
    ) {
      return unqualifiedFullSync("FULL_SYNC_HORIZON_EVIDENCE_INVALID", {
        requestedAt,
        completedAt,
        frontierAt,
      });
    }
    if (
      rowDateFrom !== deliveryDateFrom ||
      rowDateToExclusive !== deliveryDateToExclusive ||
      (pairDateFrom !== null && pairDateFrom !== rowDateFrom) ||
      (pairDateToExclusive !== null &&
        pairDateToExclusive !== rowDateToExclusive)
    ) {
      return unqualifiedFullSync("FULL_SYNC_HORIZON_EVIDENCE_MISMATCH", {
        requestedAt,
        completedAt,
        frontierAt,
      });
    }
    pairDateFrom = rowDateFrom;
    pairDateToExclusive = rowDateToExclusive;

    if (
      normalizedText(delivery.connectionId) !== mapping.connectionId ||
      normalizedText(delivery.listingId) !== mapping.listingId
    ) {
      return unqualifiedFullSync("FULL_SYNC_CORRELATION_MAPPING_MISMATCH", {
        requestedAt,
        completedAt,
        frontierAt,
      });
    }
    const expectedDateKeys = Array.from(
      { length: CHANNEX_ARI_FULL_SYNC_DAYS },
      (_, index) => addUtcDays(rowDateFrom, index),
    );
    const payloadValidation = validateFullSyncPayload({
      messageKind: row.messageKind as "AVAILABILITY" | "RATES_RESTRICTIONS",
      payload: delivery.payload,
      payloadHash: delivery.payloadHash,
      payloadValueCount: delivery.payloadValueCount,
      payloadBytes: delivery.payloadBytes,
      expectedDateKeys,
      mapping,
    });
    if (!payloadValidation.ok) {
      return unqualifiedFullSync(payloadValidation.reason, {
        requestedAt,
        completedAt,
        frontierAt,
      });
    }
    sentAtValues.push(sentAt);
  }

  const pairCompletedAt = new Date(
    Math.max(...sentAtValues.map((value) => value.getTime())),
  );
  if (pairCompletedAt.getTime() !== completedAt.getTime()) {
    return unqualifiedFullSync("FULL_SYNC_CORRELATION_STATE_MISMATCH", {
      requestedAt,
      completedAt,
      frontierAt,
    });
  }

  return {
    evidenceType: CHANNEX_CORRELATED_FULL_SYNC_EVIDENCE_TYPE,
    qualified: true,
    reason: "QUALIFIED",
    confirmedAt: new Date(completedAt),
    requestedAt,
    completedAt,
    frontierAt,
    correlationId: [...correlationIds][0]!,
    mappingFingerprint: mappingFingerprint(mapping),
    otaAcceptanceVerified: false,
  };
}

export type ChannexDistributionPropertyMappingEvidence = {
  organizationId: string;
  propertyId: string;
  platform: string;
  externalPropertyId: string | null;
  externalPrimaryRoomTypeId: string | null;
  externalPrimaryRatePlanId: string | null;
};

export type ChannexPmsConnectionMappingEvidence = {
  id: string;
  organizationId: string;
  provider: string;
  status: string;
};

export type ChannexPmsListingMappingEvidence = {
  connectionId: string;
  propertyId: string | null;
  externalListingId: string;
  metadata: unknown;
};

export type ChannexAriCanonicalMappingReason =
  | "VERIFIED"
  | "EXPECTED_SCOPE_INVALID"
  | "DISTRIBUTION_PROPERTY_MISSING"
  | "PMS_CONNECTION_MISSING"
  | "PMS_LISTING_MISSING"
  | "DISTRIBUTION_PLATFORM_MISMATCH"
  | "DISTRIBUTION_PROPERTY_SCOPE_MISMATCH"
  | "PMS_CONNECTION_SCOPE_MISMATCH"
  | "PMS_CONNECTION_NOT_ACTIVE"
  | "PMS_LISTING_SCOPE_MISMATCH"
  | "PMS_LISTING_METADATA_INVALID"
  | "PMS_LISTING_PROVIDER_MISMATCH"
  | "EXTERNAL_PROPERTY_ID_MISSING"
  | "EXTERNAL_ROOM_TYPE_ID_MISSING"
  | "EXTERNAL_RATE_PLAN_ID_MISSING"
  | "EXTERNAL_PROPERTY_ID_MISMATCH"
  | "EXTERNAL_ROOM_TYPE_ID_MISMATCH"
  | "EXTERNAL_RATE_PLAN_ID_MISMATCH";

export type ChannexAriCanonicalMappingResult = {
  verified: boolean;
  reason: ChannexAriCanonicalMappingReason;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mappingResult(
  verified: boolean,
  reason: ChannexAriCanonicalMappingReason,
): ChannexAriCanonicalMappingResult {
  return { verified, reason };
}

export function validateChannexAriCanonicalMapping(input: {
  expectedOrganizationId: string;
  expectedPropertyId: string;
  distributionProperty: ChannexDistributionPropertyMappingEvidence | null;
  pmsConnection: ChannexPmsConnectionMappingEvidence | null;
  pmsListing: ChannexPmsListingMappingEvidence | null;
}): ChannexAriCanonicalMappingResult {
  const expectedOrganizationId = normalizedText(input.expectedOrganizationId);
  const expectedPropertyId = normalizedText(input.expectedPropertyId);
  if (!expectedOrganizationId || !expectedPropertyId) {
    return mappingResult(false, "EXPECTED_SCOPE_INVALID");
  }

  const distributionProperty = input.distributionProperty;
  if (!distributionProperty) {
    return mappingResult(false, "DISTRIBUTION_PROPERTY_MISSING");
  }
  const pmsConnection = input.pmsConnection;
  if (!pmsConnection) {
    return mappingResult(false, "PMS_CONNECTION_MISSING");
  }
  const pmsListing = input.pmsListing;
  if (!pmsListing) {
    return mappingResult(false, "PMS_LISTING_MISSING");
  }

  if (normalizedText(distributionProperty.platform) !== "CHANNEX") {
    return mappingResult(false, "DISTRIBUTION_PLATFORM_MISMATCH");
  }
  if (
    normalizedText(distributionProperty.organizationId) !==
      expectedOrganizationId ||
    normalizedText(distributionProperty.propertyId) !== expectedPropertyId
  ) {
    return mappingResult(false, "DISTRIBUTION_PROPERTY_SCOPE_MISMATCH");
  }
  if (
    normalizedText(pmsConnection.organizationId) !== expectedOrganizationId ||
    normalizedText(pmsConnection.provider) !== "CHANNEX"
  ) {
    return mappingResult(false, "PMS_CONNECTION_SCOPE_MISMATCH");
  }
  if (normalizedText(pmsConnection.status) !== "ACTIVE") {
    return mappingResult(false, "PMS_CONNECTION_NOT_ACTIVE");
  }
  if (
    normalizedText(pmsListing.connectionId) !==
      normalizedText(pmsConnection.id) ||
    normalizedText(pmsListing.propertyId) !== expectedPropertyId
  ) {
    return mappingResult(false, "PMS_LISTING_SCOPE_MISMATCH");
  }

  const metadata = record(pmsListing.metadata);
  if (!metadata) {
    return mappingResult(false, "PMS_LISTING_METADATA_INVALID");
  }
  if (normalizedText(metadata.provider) !== "CHANNEX") {
    return mappingResult(false, "PMS_LISTING_PROVIDER_MISMATCH");
  }

  const canonicalPropertyId = normalizedText(
    distributionProperty.externalPropertyId,
  );
  const canonicalRoomTypeId = normalizedText(
    distributionProperty.externalPrimaryRoomTypeId,
  );
  const canonicalRatePlanId = normalizedText(
    distributionProperty.externalPrimaryRatePlanId,
  );
  if (!canonicalPropertyId) {
    return mappingResult(false, "EXTERNAL_PROPERTY_ID_MISSING");
  }
  if (!canonicalRoomTypeId) {
    return mappingResult(false, "EXTERNAL_ROOM_TYPE_ID_MISSING");
  }
  if (!canonicalRatePlanId) {
    return mappingResult(false, "EXTERNAL_RATE_PLAN_ID_MISSING");
  }

  if (normalizedText(metadata.channexPropertyId) !== canonicalPropertyId) {
    return mappingResult(false, "EXTERNAL_PROPERTY_ID_MISMATCH");
  }
  if (normalizedText(pmsListing.externalListingId) !== canonicalRoomTypeId) {
    return mappingResult(false, "EXTERNAL_ROOM_TYPE_ID_MISMATCH");
  }
  if (normalizedText(metadata.channexRatePlanId) !== canonicalRatePlanId) {
    return mappingResult(false, "EXTERNAL_RATE_PLAN_ID_MISMATCH");
  }

  return mappingResult(true, "VERIFIED");
}

export type ChannexAirbnbTransportReadinessReason =
  | "POLICY_APPLIED"
  | "PROVIDER_NOT_SUPPORTED"
  | "CHANNEL_IDENTITY_NOT_VERIFIED"
  | "CANONICAL_MAPPING_NOT_VERIFIED"
  | "CHANNEL_NOT_ACTIVE";

type ChannexAirbnbTransportReadinessStatus = "NOT_STARTED" | "NOT_APPLICABLE";

export type ChannexAirbnbTransportReadinessResult = {
  applied: boolean;
  reason: ChannexAirbnbTransportReadinessReason;
  readiness: {
    paymentReadiness: ChannexAirbnbTransportReadinessStatus;
    taxReadiness: ChannexAirbnbTransportReadinessStatus;
    contentReadiness: ChannexAirbnbTransportReadinessStatus;
  };
  metadata: {
    policyVersion: typeof CHANNEX_AIRBNB_TRANSPORT_POLICY_VERSION;
    semanticScope: typeof CHANNEX_AIRBNB_TRANSPORT_SEMANTIC_SCOPE;
    doesNotAttest: readonly [
      "AIRBNB_PAYMENT_CONFIGURATION",
      "AIRBNB_TAX_CONFIGURATION",
      "AIRBNB_LISTING_CONTENT",
      "AIRBNB_ARI_DOWNSTREAM_ACCEPTANCE",
    ];
    otaAcceptanceVerified: false;
  };
};

const FAIL_CLOSED_READINESS = {
  paymentReadiness: "NOT_STARTED",
  taxReadiness: "NOT_STARTED",
  contentReadiness: "NOT_STARTED",
} as const;

const NOT_APPLICABLE_READINESS = {
  paymentReadiness: "NOT_APPLICABLE",
  taxReadiness: "NOT_APPLICABLE",
  contentReadiness: "NOT_APPLICABLE",
} as const;

function airbnbPolicyResult(
  applied: boolean,
  reason: ChannexAirbnbTransportReadinessReason,
): ChannexAirbnbTransportReadinessResult {
  return {
    applied,
    reason,
    readiness: {
      ...(applied ? NOT_APPLICABLE_READINESS : FAIL_CLOSED_READINESS),
    },
    metadata: {
      policyVersion: CHANNEX_AIRBNB_TRANSPORT_POLICY_VERSION,
      semanticScope: CHANNEX_AIRBNB_TRANSPORT_SEMANTIC_SCOPE,
      doesNotAttest: [...CHANNEX_AIRBNB_TRANSPORT_DOES_NOT_ATTEST],
      otaAcceptanceVerified: false,
    },
  };
}

export function deriveChannexAirbnbTransportReadiness(input: {
  provider: string;
  expectedExternalConnectionId: string | null;
  expectedExternalChannelCode: string | null;
  observedChannel: {
    id: string;
    channelCode: string;
    isActive: boolean;
  } | null;
  mapping: ChannexAriCanonicalMappingResult;
}): ChannexAirbnbTransportReadinessResult {
  if (normalizedText(input.provider) !== "AIRBNB") {
    return airbnbPolicyResult(false, "PROVIDER_NOT_SUPPORTED");
  }

  const expectedConnectionId = normalizedText(
    input.expectedExternalConnectionId,
  );
  const expectedChannelCode = normalizedText(
    input.expectedExternalChannelCode,
  ).toUpperCase();
  const observedConnectionId = normalizedText(input.observedChannel?.id);
  const observedChannelCode = normalizedText(
    input.observedChannel?.channelCode,
  ).toUpperCase();
  if (
    !expectedConnectionId ||
    expectedChannelCode !== "ABB" ||
    observedConnectionId !== expectedConnectionId ||
    observedChannelCode !== "ABB"
  ) {
    return airbnbPolicyResult(false, "CHANNEL_IDENTITY_NOT_VERIFIED");
  }

  if (input.mapping.verified !== true || input.mapping.reason !== "VERIFIED") {
    return airbnbPolicyResult(false, "CANONICAL_MAPPING_NOT_VERIFIED");
  }

  if (input.observedChannel?.isActive !== true) {
    return airbnbPolicyResult(false, "CHANNEL_NOT_ACTIVE");
  }

  return airbnbPolicyResult(true, "POLICY_APPLIED");
}
