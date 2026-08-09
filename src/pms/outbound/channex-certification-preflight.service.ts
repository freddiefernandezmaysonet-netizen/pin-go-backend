import {
  assertChannexCertificationMapping,
  normalizeChannexCertificationManifest,
} from "./channex-certification-manifest.policy";
import {
  resolveChannexAriMapping,
  type ChannexAriMappingDb,
} from "./channex-ari-mapping.service";

export async function runChannexCertificationPreflight(input: {
  db: ChannexAriMappingDb;
  manifest: Record<string, unknown>;
  resolveMapping?: typeof resolveChannexAriMapping;
}) {
  const manifest = normalizeChannexCertificationManifest(input.manifest);
  const resolveMapping = input.resolveMapping ?? resolveChannexAriMapping;
  const mapping = await resolveMapping(input.db, {
    organizationId: manifest.organizationId,
    propertyId: manifest.propertyId,
  });

  assertChannexCertificationMapping({
    manifest,
    actual: {
      organizationId: mapping.propertyOrganizationId,
      propertyId: mapping.propertyId,
      channexPropertyId: mapping.channexPropertyId,
      externalRoomTypeId: mapping.externalRoomTypeId,
      channexRatePlanId: mapping.channexRatePlanId,
      connectionId: mapping.connectionId,
      listingId: mapping.listingId,
    },
  });

  return {
    ok: true as const,
    manifest,
    mapping,
  };
}
