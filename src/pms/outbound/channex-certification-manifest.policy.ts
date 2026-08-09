export type ChannexCertificationManifest = Readonly<{
  organizationId: string;
  propertyId: string;
  channexPropertyId: string;
  channexRoomTypeId: string;
  channexRatePlanId: string;
  connectionId: string;
  listingId: string;
}>;

export type ChannexCertificationActualMapping = {
  organizationId: string;
  propertyId: string;
  channexPropertyId: string;
  externalRoomTypeId: string;
  channexRatePlanId: string;
  connectionId: string;
  listingId: string;
};

const MANIFEST_FIELDS = [
  "organizationId",
  "propertyId",
  "channexPropertyId",
  "channexRoomTypeId",
  "channexRatePlanId",
  "connectionId",
  "listingId",
] as const;

function requireText(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(
      `CHANNEX_CERTIFICATION_MANIFEST_${field.toUpperCase()}_REQUIRED`
    );
  }

  return normalized;
}

export function normalizeChannexCertificationManifest(
  input: Record<string, unknown>
): ChannexCertificationManifest {
  const normalized = Object.fromEntries(
    MANIFEST_FIELDS.map((field) => [field, requireText(input[field], field)])
  ) as ChannexCertificationManifest;

  return Object.freeze(normalized);
}

export function assertChannexCertificationMapping(input: {
  manifest: Record<string, unknown>;
  actual: ChannexCertificationActualMapping;
}): ChannexCertificationManifest {
  const manifest = normalizeChannexCertificationManifest(input.manifest);
  const comparisons: Array<{
    actualField: keyof ChannexCertificationActualMapping;
    expected: string;
  }> = [
    { actualField: "organizationId", expected: manifest.organizationId },
    { actualField: "propertyId", expected: manifest.propertyId },
    { actualField: "channexPropertyId", expected: manifest.channexPropertyId },
    { actualField: "externalRoomTypeId", expected: manifest.channexRoomTypeId },
    { actualField: "channexRatePlanId", expected: manifest.channexRatePlanId },
    { actualField: "connectionId", expected: manifest.connectionId },
    { actualField: "listingId", expected: manifest.listingId },
  ];

  for (const comparison of comparisons) {
    const actual = String(input.actual[comparison.actualField] ?? "").trim();

    if (actual !== comparison.expected) {
      throw new Error(
        `CHANNEX_CERTIFICATION_${comparison.actualField.toUpperCase()}_MISMATCH`
      );
    }
  }

  return manifest;
}
