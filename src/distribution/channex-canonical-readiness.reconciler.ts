import type { ConnectionCenterProvider } from "./connection-center.read-model.js";

export type CanonicalReadiness = "REQUIRED" | "NOT_STARTED" | "IN_PROGRESS" | "READY" | "BLOCKED";

export type CanonicalOtaReadinessEvidence = {
  provider: ConnectionCenterProvider;
  expectedPropertyId: string;
  expectedRoomTypeId: string;
  expectedRatePlanId: string;
  externalConnectionId: string | null;
  externalChannelCode: string | null;
  propertyPayload: unknown;
  roomTypesPayload: unknown;
  ratePlansPayload: unknown;
  latestLifecycleEvent?: "new_channel" | "updated_channel" | "activate_channel" | "deactivate_channel" | "disconnected_channel" | "disconnect_listing" | null;
};

export type CanonicalOtaReadinessResult = {
  authorizationReadiness: CanonicalReadiness;
  mappingReadiness: CanonicalReadiness;
  distributionReadiness: CanonicalReadiness;
  reasons: string[];
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function dataRecord(payload: unknown): Record<string, any> {
  const data = record(record(payload).data);
  return data;
}

function dataList(payload: unknown): Array<Record<string, any>> {
  const data = record(payload).data;
  return Array.isArray(data) ? data.map(record) : [];
}

function resourceId(item: Record<string, any>): string {
  return String(item.id ?? "").trim();
}

function channelCount(payload: unknown): number | null {
  const attributes = record(dataRecord(payload).attributes);
  const raw = attributes.acc_channels_count ?? attributes.acc_cannels_count;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function expectedChannelCode(provider: ConnectionCenterProvider): string | null {
  if (provider === "AIRBNB") return "ABB";
  if (provider === "BOOKING_COM") return "BDC";
  return null;
}

export function deriveCanonicalOtaReadiness(
  evidence: CanonicalOtaReadinessEvidence
): CanonicalOtaReadinessResult {
  const reasons: string[] = [];
  const property = dataRecord(evidence.propertyPayload);
  const propertyMatches = resourceId(property) === evidence.expectedPropertyId;
  const roomMatches = dataList(evidence.roomTypesPayload).some(
    (item) => resourceId(item) === evidence.expectedRoomTypeId
  );
  const rateMatches = dataList(evidence.ratePlansPayload).some(
    (item) => resourceId(item) === evidence.expectedRatePlanId
  );
  const expectedCode = expectedChannelCode(evidence.provider);
  const channelIdentity = Boolean(
    evidence.externalConnectionId &&
      expectedCode &&
      String(evidence.externalChannelCode ?? "").trim().toUpperCase() === expectedCode
  );
  const connectedCount = channelCount(evidence.propertyPayload);
  const lifecycle = evidence.latestLifecycleEvent ?? null;

  if (!propertyMatches) reasons.push("PROPERTY_NOT_CANONICALLY_VERIFIED");
  if (!roomMatches) reasons.push("ROOM_TYPE_NOT_CANONICALLY_VERIFIED");
  if (!rateMatches) reasons.push("RATE_PLAN_NOT_CANONICALLY_VERIFIED");
  if (!channelIdentity) reasons.push("CHANNEL_IDENTITY_NOT_VERIFIED");
  if (connectedCount === null) reasons.push("CONNECTED_CHANNEL_COUNT_UNAVAILABLE");
  else if (connectedCount < 1) reasons.push("NO_CONNECTED_CHANNEL_EVIDENCE");

  if (lifecycle === "disconnected_channel") {
    return {
      authorizationReadiness: "REQUIRED",
      mappingReadiness: "BLOCKED",
      distributionReadiness: "BLOCKED",
      reasons: [...reasons, "CHANNEL_DISCONNECTED"],
    };
  }
  if (lifecycle === "disconnect_listing") {
    return {
      authorizationReadiness: channelIdentity ? "READY" : "IN_PROGRESS",
      mappingReadiness: "BLOCKED",
      distributionReadiness: "BLOCKED",
      reasons: [...reasons, "LISTING_DISCONNECTED"],
    };
  }
  if (lifecycle === "deactivate_channel") {
    return {
      authorizationReadiness: channelIdentity ? "READY" : "IN_PROGRESS",
      mappingReadiness: propertyMatches && roomMatches && rateMatches ? "READY" : "IN_PROGRESS",
      distributionReadiness: "BLOCKED",
      reasons: [...reasons, "CHANNEL_DEACTIVATED"],
    };
  }

  const authorizationReady =
    propertyMatches && channelIdentity && connectedCount !== null && connectedCount > 0;
  const mappingReady = propertyMatches && roomMatches && rateMatches;
  const distributionReady =
    authorizationReady && mappingReady && lifecycle === "activate_channel";

  return {
    authorizationReadiness: authorizationReady ? "READY" : "IN_PROGRESS",
    mappingReadiness: mappingReady ? "READY" : "IN_PROGRESS",
    distributionReadiness: distributionReady ? "READY" : "IN_PROGRESS",
    reasons,
  };
}
