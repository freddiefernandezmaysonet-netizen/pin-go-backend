import { discoverAirbnbHostListings, type AirbnbHostListingsTransport } from "./airbnb-host-self-service.listings.service.js";
import type { AirbnbHostSelfServiceClient } from "./airbnb-host-self-service.service.js";

export class AirbnbHostMappingPlanError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbHostMappingPlanError";
  }
}

export type AirbnbMappingRequest = {
  mapping: { rate_plan_id: string; settings: { listing_id: string } };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.length) throw new AirbnbHostMappingPlanError(code);
  return value;
}
function uuid(value: unknown, code: string): string {
  const id = text(value, code);
  if (!UUID.test(id)) throw new AirbnbHostMappingPlanError(code);
  return id;
}

// Pure construction of the supplied guide's mapping body; no send capability.
export function buildAirbnbMappingRequest(args: { ratePlanId: string; listingId: string }): AirbnbMappingRequest {
  return { mapping: {
    rate_plan_id: uuid(args.ratePlanId, "OTA_AIRBNB_MAPPING_RATE_PLAN_ID_INVALID"),
    settings: { listing_id: text(args.listingId, "OTA_AIRBNB_MAPPING_LISTING_ID_INVALID") },
  } };
}

/**
 * Read-only proposal, NOT execution readiness or a provider dry-run endpoint.
 * The stored primary plan is a Pin&Go proposal, not a Channex restriction.
 * Its live existence/ownership and existing mappings are not certified here.
 */
export async function prepareAirbnbHostMappingPlan(args: {
  client: AirbnbHostSelfServiceClient;
  transport: AirbnbHostListingsTransport;
  organizationId: string;
  propertyId: string;
  channelId: string;
  listingId: string;
}): Promise<{
  propertyId: string;
  channelId: string;
  listing: { id: string; title: string };
  ratePlan: { id: string; source: "PIN_GO_PRIMARY_RATE_PLAN" };
  mappingRequest: AirbnbMappingRequest;
  executable: false;
  nextAction: "MAPPING_EXECUTION_REQUIRES_APPROVAL";
}> {
  const organizationId = text(args.organizationId, "OTA_AIRBNB_TENANT_INVALID");
  const propertyId = text(args.propertyId, "OTA_AIRBNB_PROPERTY_INVALID");
  const channelId = uuid(args.channelId, "OTA_AIRBNB_CHANNEL_ID_INVALID");
  const listingId = text(args.listingId, "OTA_AIRBNB_MAPPING_LISTING_ID_INVALID");
  const row = await args.client.distributionProperty.findFirst({
    where: { organizationId, propertyId, platform: "CHANNEX" },
    select: {
      organizationId: true, propertyId: true, platform: true, provisioningStatus: true,
      externalPropertyId: true, externalPrimaryRoomTypeId: true, externalPrimaryRatePlanId: true,
      group: { select: { organizationId: true, platform: true, provisioningStatus: true, externalGroupId: true } },
    },
  });
  // Use one local snapshot for both boundary verification and the proposed plan.
  // Existing discovery validates the row and reads the exact channel + listings.
  const snapshot = row === null ? null : { ...row, group: row.group ? { ...row.group } : null };
  const discovery = await discoverAirbnbHostListings({
    client: { distributionProperty: { async findFirst() { return snapshot; } } },
    transport: args.transport, organizationId, propertyId, channelId,
  });
  const listing = discovery.listings.find(candidate => candidate.id === listingId);
  if (!listing) throw new AirbnbHostMappingPlanError("OTA_AIRBNB_MAPPING_LISTING_NOT_FOUND");
  const ratePlanId = uuid(snapshot?.externalPrimaryRatePlanId, "OTA_AIRBNB_MAPPING_RATE_PLAN_ID_INVALID");
  return {
    propertyId, channelId,
    listing: { id: listing.id, title: listing.title },
    ratePlan: { id: ratePlanId, source: "PIN_GO_PRIMARY_RATE_PLAN" },
    mappingRequest: buildAirbnbMappingRequest({ ratePlanId, listingId: listing.id }),
    executable: false, nextAction: "MAPPING_EXECUTION_REQUIRES_APPROVAL",
  };
}
