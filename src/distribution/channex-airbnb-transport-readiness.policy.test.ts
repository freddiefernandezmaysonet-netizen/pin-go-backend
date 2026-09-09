import assert from "node:assert/strict";
import test from "node:test";

import { calculateChannexAriCanonicalJsonIntegrity } from "../pms/outbound/channex-ari-canonical-json.policy.js";
import { addUtcDays } from "../pms/outbound/channex-ari-lifecycle.policy.js";
import {
  CHANNEX_AIRBNB_TRANSPORT_DOES_NOT_ATTEST,
  CHANNEX_AIRBNB_TRANSPORT_POLICY_VERSION,
  CHANNEX_AIRBNB_TRANSPORT_SEMANTIC_SCOPE,
  CHANNEX_CORRELATED_FULL_SYNC_EVIDENCE_TYPE,
  deriveChannexAirbnbTransportReadiness,
  qualifyChannexCorrelatedFullSyncEvidence,
  validateChannexAriCanonicalMapping,
} from "./channex-airbnb-transport-readiness.policy.js";

const ACTIVATED_AT = new Date("2026-09-07T10:00:00.000Z");
const LIFECYCLE_AT = new Date("2026-09-07T10:05:00.000Z");
const REQUESTED_AT = new Date("2026-09-07T10:06:00.000Z");
const COMPLETED_AT = new Date("2026-09-07T10:07:00.000Z");
const FULL_SYNC_DATE_FROM = "2026-09-07";
const FULL_SYNC_DATE_TO_EXCLUSIVE = addUtcDays(FULL_SYNC_DATE_FROM, 500);
const FULL_SYNC_LAST_DATE = addUtcDays(FULL_SYNC_DATE_FROM, 499);

function databaseDate(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function payloadEvidence(payload: unknown) {
  const integrity = calculateChannexAriCanonicalJsonIntegrity(payload);
  return {
    payload,
    payloadHash: integrity.payloadHash,
    payloadValueCount: (payload as { values: unknown[] }).values.length,
    payloadBytes: integrity.payloadBytes,
  };
}

function propertyState(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    propertyId: "property-1",
    lastFullSyncRequestedAt: REQUESTED_AT,
    lastFullSyncCompletedAt: COMPLETED_AT,
    ...overrides,
  };
}

function fullSyncPair(requestedAt: Date, completedAt: Date) {
  const availabilityPayload = {
    values: [
      {
        property_id: "channex-property-1",
        room_type_id: "room-type-1",
        date_from: FULL_SYNC_DATE_FROM,
        date_to: FULL_SYNC_LAST_DATE,
        availability: 1,
      },
    ],
  };
  const ratesPayload = {
    values: [
      {
        property_id: "channex-property-1",
        rate_plan_id: "rate-plan-1",
        date_from: FULL_SYNC_DATE_FROM,
        date_to: FULL_SYNC_LAST_DATE,
        rate: "100",
        min_stay_arrival: 1,
        min_stay_through: 1,
        max_stay: 0,
      },
    ],
  };
  return [
    {
      id: "outbox-availability",
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "CHANNEX",
      messageKind: "AVAILABILITY",
      syncMode: "FULL",
      scope: "FULL_HORIZON",
      status: "MERGED",
      correlationId: "full-sync-1",
      dateFrom: databaseDate(FULL_SYNC_DATE_FROM),
      dateToExclusive: databaseDate(FULL_SYNC_DATE_TO_EXCLUSIVE),
      dateKeys: [],
      createdAt: requestedAt,
      deliveryId: "delivery-availability",
      delivery: {
        id: "delivery-availability",
        organizationId: "org-1",
        propertyId: "property-1",
        connectionId: "pms-connection-1",
        listingId: "pms-listing-1",
        messageKind: "AVAILABILITY",
        syncMode: "FULL",
        scope: "FULL_HORIZON",
        dateFrom: databaseDate(FULL_SYNC_DATE_FROM),
        dateToExclusive: databaseDate(FULL_SYNC_DATE_TO_EXCLUSIVE),
        dateKeys: [],
        status: "SENT",
        sentAt: requestedAt,
        ...payloadEvidence(availabilityPayload),
      },
    },
    {
      id: "outbox-rates",
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "CHANNEX",
      messageKind: "RATES_RESTRICTIONS",
      syncMode: "FULL",
      scope: "FULL_HORIZON",
      status: "MERGED",
      correlationId: "full-sync-1",
      dateFrom: databaseDate(FULL_SYNC_DATE_FROM),
      dateToExclusive: databaseDate(FULL_SYNC_DATE_TO_EXCLUSIVE),
      dateKeys: [],
      createdAt: requestedAt,
      deliveryId: "delivery-rates",
      delivery: {
        id: "delivery-rates",
        organizationId: "org-1",
        propertyId: "property-1",
        connectionId: "pms-connection-1",
        listingId: "pms-listing-1",
        messageKind: "RATES_RESTRICTIONS",
        syncMode: "FULL",
        scope: "FULL_HORIZON",
        dateFrom: databaseDate(FULL_SYNC_DATE_FROM),
        dateToExclusive: databaseDate(FULL_SYNC_DATE_TO_EXCLUSIVE),
        dateKeys: [],
        status: "SENT",
        sentAt: completedAt,
        ...payloadEvidence(ratesPayload),
      },
    },
  ];
}

function replaceDeliveryPayload(
  pair: ReturnType<typeof fullSyncPair>,
  index: number,
  payload: unknown,
): void {
  Object.assign(pair[index]!.delivery!, payloadEvidence(payload));
}

function fullSyncInput(overrides: Record<string, unknown> = {}) {
  const state = (overrides.state ?? propertyState()) as ReturnType<
    typeof propertyState
  >;
  return {
    expectedOrganizationId: "org-1",
    expectedPropertyId: "property-1",
    expectedConnectionId: "pms-connection-1",
    expectedListingId: "pms-listing-1",
    expectedExternalPropertyId: "channex-property-1",
    expectedExternalRoomTypeId: "room-type-1",
    expectedExternalRatePlanId: "rate-plan-1",
    state,
    outboxEvidence:
      overrides.outboxEvidence ??
      (state.lastFullSyncRequestedAt instanceof Date &&
      state.lastFullSyncCompletedAt instanceof Date
        ? fullSyncPair(
            state.lastFullSyncRequestedAt,
            state.lastFullSyncCompletedAt,
          )
        : []),
    lastChannelActivatedAt: ACTIVATED_AT,
    lastLifecycleOccurredAt: LIFECYCLE_AT,
    mappingLastChangedAt: ACTIVATED_AT,
    ...overrides,
  } as Parameters<typeof qualifyChannexCorrelatedFullSyncEvidence>[0];
}

test("qualifies only a correlated Channex full sync completed at or after the lifecycle frontier", () => {
  const result = qualifyChannexCorrelatedFullSyncEvidence(fullSyncInput());

  assert.equal(result.evidenceType, CHANNEX_CORRELATED_FULL_SYNC_EVIDENCE_TYPE);
  assert.equal(result.qualified, true);
  assert.equal(result.reason, "QUALIFIED");
  assert.deepEqual(result.frontierAt, LIFECYCLE_AT);
  assert.deepEqual(result.confirmedAt, COMPLETED_AT);
  assert.equal(result.otaAcceptanceVerified, false);
});

test("uses the later activation timestamp when it is newer than the latest lifecycle timestamp", () => {
  const laterActivation = new Date("2026-09-07T10:08:00.000Z");
  const result = qualifyChannexCorrelatedFullSyncEvidence(
    fullSyncInput({
      lastChannelActivatedAt: laterActivation,
      state: propertyState({
        lastFullSyncRequestedAt: laterActivation,
        lastFullSyncCompletedAt: laterActivation,
      }),
    }),
  );

  assert.equal(result.qualified, true);
  assert.deepEqual(result.frontierAt, laterActivation);
});

test("rejects missing lifecycle, request and completion evidence fail-closed", () => {
  const cases = [
    {
      input: fullSyncInput({ lastChannelActivatedAt: null }),
      reason: "CHANNEL_ACTIVATION_EVIDENCE_MISSING",
    },
    {
      input: fullSyncInput({ lastLifecycleOccurredAt: null }),
      reason: "LIFECYCLE_EVIDENCE_MISSING",
    },
    {
      input: fullSyncInput({
        state: propertyState({ lastFullSyncRequestedAt: null }),
      }),
      reason: "FULL_SYNC_REQUEST_EVIDENCE_MISSING",
    },
    {
      input: fullSyncInput({
        state: propertyState({ lastFullSyncCompletedAt: null }),
      }),
      reason: "FULL_SYNC_COMPLETION_EVIDENCE_MISSING",
    },
  ] as const;

  for (const scenario of cases) {
    const result = qualifyChannexCorrelatedFullSyncEvidence(scenario.input);
    assert.equal(result.qualified, false);
    assert.equal(result.reason, scenario.reason);
    assert.equal(result.confirmedAt, null);
    assert.equal(result.otaAcceptanceVerified, false);
  }
});

test("rejects cross-tenant and cross-property property state", () => {
  for (const state of [
    propertyState({ organizationId: "org-2" }),
    propertyState({ propertyId: "property-2" }),
  ]) {
    const result = qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ state }),
    );
    assert.equal(result.qualified, false);
    assert.equal(result.reason, "PROPERTY_STATE_SCOPE_MISMATCH");
  }
});

test("rejects completion before its request or before the lifecycle frontier", () => {
  const beforeRequest = qualifyChannexCorrelatedFullSyncEvidence(
    fullSyncInput({
      state: propertyState({
        lastFullSyncRequestedAt: COMPLETED_AT,
        lastFullSyncCompletedAt: REQUESTED_AT,
      }),
    }),
  );
  assert.equal(beforeRequest.qualified, false);
  assert.equal(beforeRequest.reason, "FULL_SYNC_COMPLETION_PREDATES_REQUEST");

  const beforeFrontier = qualifyChannexCorrelatedFullSyncEvidence(
    fullSyncInput({
      state: propertyState({
        lastFullSyncRequestedAt: new Date("2026-09-07T09:58:00.000Z"),
        lastFullSyncCompletedAt: new Date("2026-09-07T10:04:00.000Z"),
      }),
    }),
  );
  assert.equal(beforeFrontier.qualified, false);
  assert.equal(beforeFrontier.reason, "FULL_SYNC_COMPLETION_PREDATES_FRONTIER");
  assert.equal(beforeFrontier.confirmedAt, null);

  const requestBeforeFrontier = qualifyChannexCorrelatedFullSyncEvidence(
    fullSyncInput({
      state: propertyState({
        lastFullSyncRequestedAt: new Date("2026-09-07T10:04:00.000Z"),
        lastFullSyncCompletedAt: COMPLETED_AT,
      }),
    }),
  );
  assert.equal(requestBeforeFrontier.qualified, false);
  assert.equal(
    requestBeforeFrontier.reason,
    "FULL_SYNC_REQUEST_PREDATES_FRONTIER",
  );
});

test("requires one exact correlated SENT pair bound to current mapping and payload", () => {
  const missing = qualifyChannexCorrelatedFullSyncEvidence(
    fullSyncInput({ outboxEvidence: [] }),
  );
  assert.equal(missing.reason, "FULL_SYNC_CORRELATION_EVIDENCE_MISSING");

  const differentCorrelations = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  differentCorrelations[1]!.correlationId = "full-sync-2";
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: differentCorrelations }),
    ).reason,
    "FULL_SYNC_CORRELATION_PAIR_INVALID",
  );

  const staleMapping = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  staleMapping[0]!.delivery!.listingId = "previous-listing";
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: staleMapping }),
    ).reason,
    "FULL_SYNC_CORRELATION_MAPPING_MISMATCH",
  );

  const wrongPayload = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  (wrongPayload[1]!.delivery!.payload as any).values[0].rate_plan_id =
    "previous-rate-plan";
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: wrongPayload }),
    ).reason,
    "FULL_SYNC_CORRELATION_PAYLOAD_MISMATCH",
  );
});

test("requires persisted outbox and delivery bounds for one exact 500-day horizon", () => {
  const missingBounds = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  missingBounds[0]!.dateFrom = null;
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: missingBounds }),
    ).reason,
    "FULL_SYNC_HORIZON_EVIDENCE_INVALID",
  );

  const shortHorizon = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  const shortToExclusive = databaseDate(addUtcDays(FULL_SYNC_DATE_FROM, 499));
  shortHorizon[0]!.dateToExclusive = shortToExclusive;
  shortHorizon[0]!.delivery!.dateToExclusive = shortToExclusive;
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: shortHorizon }),
    ).reason,
    "FULL_SYNC_HORIZON_EVIDENCE_INVALID",
  );

  const unexpectedDateKeys = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  unexpectedDateKeys[1]!.delivery!.dateKeys = [FULL_SYNC_DATE_FROM];
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: unexpectedDateKeys }),
    ).reason,
    "FULL_SYNC_HORIZON_EVIDENCE_INVALID",
  );
});

test("rejects different horizons across the correlated pair or its delivery", () => {
  const shiftedPairMember = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  const shiftedFrom = addUtcDays(FULL_SYNC_DATE_FROM, 1);
  const shiftedToExclusive = addUtcDays(shiftedFrom, 500);
  shiftedPairMember[1]!.dateFrom = databaseDate(shiftedFrom);
  shiftedPairMember[1]!.dateToExclusive = databaseDate(shiftedToExclusive);
  shiftedPairMember[1]!.delivery!.dateFrom = databaseDate(shiftedFrom);
  shiftedPairMember[1]!.delivery!.dateToExclusive =
    databaseDate(shiftedToExclusive);
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: shiftedPairMember }),
    ).reason,
    "FULL_SYNC_HORIZON_EVIDENCE_MISMATCH",
  );

  const deliveryDrift = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  deliveryDrift[0]!.delivery!.dateFrom = databaseDate(
    addUtcDays(FULL_SYNC_DATE_FROM, 1),
  );
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: deliveryDrift }),
    ).reason,
    "FULL_SYNC_HORIZON_EVIDENCE_MISMATCH",
  );
});

test("rejects partial, gapped, overlapping and non-canonical full-sync payload horizons", () => {
  const partial = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  replaceDeliveryPayload(partial, 0, {
    values: [
      {
        property_id: "channex-property-1",
        room_type_id: "room-type-1",
        date_from: FULL_SYNC_DATE_FROM,
        date_to: addUtcDays(FULL_SYNC_DATE_FROM, 498),
        availability: 1,
      },
    ],
  });

  const gapped = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  replaceDeliveryPayload(gapped, 0, {
    values: [
      {
        property_id: "channex-property-1",
        room_type_id: "room-type-1",
        date_from: FULL_SYNC_DATE_FROM,
        date_to: addUtcDays(FULL_SYNC_DATE_FROM, 249),
        availability: 1,
      },
      {
        property_id: "channex-property-1",
        room_type_id: "room-type-1",
        date_from: addUtcDays(FULL_SYNC_DATE_FROM, 251),
        date_to: FULL_SYNC_LAST_DATE,
        availability: 0,
      },
    ],
  });

  const overlapping = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  replaceDeliveryPayload(overlapping, 1, {
    values: [
      {
        property_id: "channex-property-1",
        rate_plan_id: "rate-plan-1",
        date_from: FULL_SYNC_DATE_FROM,
        date_to: addUtcDays(FULL_SYNC_DATE_FROM, 250),
        rate: "100",
        min_stay_arrival: 1,
        min_stay_through: 1,
        max_stay: 0,
      },
      {
        property_id: "channex-property-1",
        rate_plan_id: "rate-plan-1",
        date_from: addUtcDays(FULL_SYNC_DATE_FROM, 250),
        date_to: FULL_SYNC_LAST_DATE,
        rate: "120",
        min_stay_arrival: 1,
        min_stay_through: 1,
        max_stay: 0,
      },
    ],
  });

  const reversedSegments = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  replaceDeliveryPayload(reversedSegments, 0, {
    values: [
      {
        property_id: "channex-property-1",
        room_type_id: "room-type-1",
        date_from: addUtcDays(FULL_SYNC_DATE_FROM, 250),
        date_to: FULL_SYNC_LAST_DATE,
        availability: 0,
      },
      {
        property_id: "channex-property-1",
        room_type_id: "room-type-1",
        date_from: FULL_SYNC_DATE_FROM,
        date_to: addUtcDays(FULL_SYNC_DATE_FROM, 249),
        availability: 1,
      },
    ],
  });

  for (const evidence of [partial, gapped, overlapping, reversedSegments]) {
    const result = qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: evidence }),
    );
    assert.equal(result.qualified, false);
    assert.equal(result.reason, "FULL_SYNC_PAYLOAD_HORIZON_INVALID");
  }
});

test("requires complete FULL payload fields and persisted canonical integrity", () => {
  const missingFullRateField = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  replaceDeliveryPayload(missingFullRateField, 1, {
    values: [
      {
        property_id: "channex-property-1",
        rate_plan_id: "rate-plan-1",
        date_from: FULL_SYNC_DATE_FROM,
        date_to: FULL_SYNC_LAST_DATE,
        rate: "100",
        min_stay_arrival: 1,
        min_stay_through: 1,
      },
    ],
  });
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: missingFullRateField }),
    ).reason,
    "FULL_SYNC_PAYLOAD_SHAPE_INVALID",
  );

  const countMismatch = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  countMismatch[0]!.delivery!.payloadValueCount = 2;
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: countMismatch }),
    ).reason,
    "FULL_SYNC_PAYLOAD_INTEGRITY_INVALID",
  );

  const hashMismatch = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  hashMismatch[1]!.delivery!.payloadHash = "0".repeat(64);
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: hashMismatch }),
    ).reason,
    "FULL_SYNC_PAYLOAD_INTEGRITY_INVALID",
  );

  const bytesMismatch = fullSyncPair(REQUESTED_AT, COMPLETED_AT);
  bytesMismatch[1]!.delivery!.payloadBytes += 1;
  assert.equal(
    qualifyChannexCorrelatedFullSyncEvidence(
      fullSyncInput({ outboxEvidence: bytesMismatch }),
    ).reason,
    "FULL_SYNC_PAYLOAD_INTEGRITY_INVALID",
  );
});

test("a full sync predating the current mapping revision is rejected", () => {
  const result = qualifyChannexCorrelatedFullSyncEvidence(
    fullSyncInput({
      mappingLastChangedAt: new Date("2026-09-07T10:06:30.000Z"),
    }),
  );
  assert.equal(result.qualified, false);
  assert.equal(result.reason, "FULL_SYNC_REQUEST_PREDATES_FRONTIER");
});

function distributionProperty(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    propertyId: "property-1",
    platform: "CHANNEX",
    externalPropertyId: "channex-property-1",
    externalPrimaryRoomTypeId: "room-type-1",
    externalPrimaryRatePlanId: "rate-plan-1",
    ...overrides,
  };
}

function pmsConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "pms-connection-1",
    organizationId: "org-1",
    provider: "CHANNEX",
    status: "ACTIVE",
    ...overrides,
  };
}

function pmsListing(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "pms-connection-1",
    propertyId: "property-1",
    externalListingId: "room-type-1",
    metadata: {
      provider: "CHANNEX",
      channexPropertyId: "channex-property-1",
      channexRatePlanId: "rate-plan-1",
    },
    ...overrides,
  };
}

function mappingInput(overrides: Record<string, unknown> = {}) {
  return {
    expectedOrganizationId: "org-1",
    expectedPropertyId: "property-1",
    distributionProperty: distributionProperty(),
    pmsConnection: pmsConnection(),
    pmsListing: pmsListing(),
    ...overrides,
  } as Parameters<typeof validateChannexAriCanonicalMapping>[0];
}

test("verifies the real Channex PmsListing metadata shape against DistributionProperty", () => {
  assert.deepEqual(validateChannexAriCanonicalMapping(mappingInput()), {
    verified: true,
    reason: "VERIFIED",
  });
});

test("mapping metadata never accepts string-coercible arrays", () => {
  assert.equal(
    validateChannexAriCanonicalMapping(
      mappingInput({
        pmsListing: pmsListing({
          metadata: {
            provider: ["CHANNEX"],
            channexPropertyId: ["channex-property-1"],
            channexRatePlanId: ["rate-plan-1"],
          },
        }),
      }),
    ).verified,
    false,
  );
});

test("rejects every external property, room type and rate plan mismatch independently", () => {
  const cases = [
    {
      listing: pmsListing({
        metadata: {
          provider: "CHANNEX",
          channexPropertyId: "other-property",
          channexRatePlanId: "rate-plan-1",
        },
      }),
      reason: "EXTERNAL_PROPERTY_ID_MISMATCH",
    },
    {
      listing: pmsListing({ externalListingId: "other-room" }),
      reason: "EXTERNAL_ROOM_TYPE_ID_MISMATCH",
    },
    {
      listing: pmsListing({
        metadata: {
          provider: "CHANNEX",
          channexPropertyId: "channex-property-1",
          channexRatePlanId: "other-rate",
        },
      }),
      reason: "EXTERNAL_RATE_PLAN_ID_MISMATCH",
    },
  ] as const;

  for (const scenario of cases) {
    assert.deepEqual(
      validateChannexAriCanonicalMapping(
        mappingInput({ pmsListing: scenario.listing }),
      ),
      { verified: false, reason: scenario.reason },
    );
  }
});

test("rejects organization, property, connection and provider scope drift", () => {
  const cases = [
    {
      input: mappingInput({
        distributionProperty: distributionProperty({ organizationId: "org-2" }),
      }),
      reason: "DISTRIBUTION_PROPERTY_SCOPE_MISMATCH",
    },
    {
      input: mappingInput({
        pmsConnection: pmsConnection({ provider: "GUESTY" }),
      }),
      reason: "PMS_CONNECTION_SCOPE_MISMATCH",
    },
    {
      input: mappingInput({
        pmsConnection: pmsConnection({ status: "DISABLED" }),
      }),
      reason: "PMS_CONNECTION_NOT_ACTIVE",
    },
    {
      input: mappingInput({
        pmsListing: pmsListing({ propertyId: "property-2" }),
      }),
      reason: "PMS_LISTING_SCOPE_MISMATCH",
    },
    {
      input: mappingInput({
        pmsListing: pmsListing({ connectionId: "other-connection" }),
      }),
      reason: "PMS_LISTING_SCOPE_MISMATCH",
    },
  ] as const;

  for (const scenario of cases) {
    const result = validateChannexAriCanonicalMapping(scenario.input);
    assert.equal(result.verified, false);
    assert.equal(result.reason, scenario.reason);
  }
});

function verifiedMapping() {
  return validateChannexAriCanonicalMapping(mappingInput());
}

function airbnbPolicyInput(overrides: Record<string, unknown> = {}) {
  return {
    provider: "AIRBNB",
    expectedExternalConnectionId: "airbnb-channel-1",
    expectedExternalChannelCode: "ABB",
    observedChannel: {
      id: "airbnb-channel-1",
      channelCode: "ABB",
      isActive: true,
    },
    mapping: verifiedMapping(),
    ...overrides,
  } as Parameters<typeof deriveChannexAirbnbTransportReadiness>[0];
}

test("applies the versioned Airbnb transport-only policy without claiming commercial or OTA evidence", () => {
  const result = deriveChannexAirbnbTransportReadiness(airbnbPolicyInput());

  assert.equal(result.applied, true);
  assert.equal(result.reason, "POLICY_APPLIED");
  assert.deepEqual(result.readiness, {
    paymentReadiness: "NOT_APPLICABLE",
    taxReadiness: "NOT_APPLICABLE",
    contentReadiness: "NOT_APPLICABLE",
  });
  assert.deepEqual(result.metadata, {
    policyVersion: CHANNEX_AIRBNB_TRANSPORT_POLICY_VERSION,
    semanticScope: CHANNEX_AIRBNB_TRANSPORT_SEMANTIC_SCOPE,
    doesNotAttest: [...CHANNEX_AIRBNB_TRANSPORT_DOES_NOT_ATTEST],
    otaAcceptanceVerified: false,
  });
});

test("does not apply NOT_APPLICABLE until exact channel identity, mapping and active state are proven", () => {
  const cases = [
    airbnbPolicyInput({
      observedChannel: {
        id: "other-channel",
        channelCode: "ABB",
        isActive: true,
      },
    }),
    airbnbPolicyInput({
      mapping: { verified: false, reason: "EXTERNAL_RATE_PLAN_ID_MISMATCH" },
    }),
    airbnbPolicyInput({
      observedChannel: {
        id: "airbnb-channel-1",
        channelCode: "ABB",
        isActive: false,
      },
    }),
  ];

  for (const input of cases) {
    const result = deriveChannexAirbnbTransportReadiness(input);
    assert.equal(result.applied, false);
    assert.deepEqual(result.readiness, {
      paymentReadiness: "NOT_STARTED",
      taxReadiness: "NOT_STARTED",
      contentReadiness: "NOT_STARTED",
    });
  }
});

test("all non-Airbnb providers remain fail-closed", () => {
  for (const provider of ["BOOKING_COM", "EXPEDIA", "VRBO"]) {
    const result = deriveChannexAirbnbTransportReadiness(
      airbnbPolicyInput({ provider }),
    );
    assert.equal(result.applied, false);
    assert.equal(result.reason, "PROVIDER_NOT_SUPPORTED");
    assert.ok(
      Object.values(result.readiness).every(
        (status) => status === "NOT_STARTED",
      ),
    );
  }
});
