import type { GuestJourneyActivationControlPlaneConfig } from "./guest-journey-activation-control-plane.service";

export const GUEST_JOURNEY_RUNTIME_ENFORCEMENT_VERSION =
  "guest_journey_runtime_enforcement_v1" as const;

export type GuestJourneyRuntimeScopePrisma = {
  organization: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
  property: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; organizationId: true };
    }): Promise<
      Array<{
        id: string;
        organizationId: string;
      }>
    >;
  };
};

export type GuestJourneyRuntimeScopePreflight = {
  version: typeof GUEST_JOURNEY_RUNTIME_ENFORCEMENT_VERSION;
  profile: GuestJourneyActivationControlPlaneConfig["profile"];
  enforced: boolean;
  reason: "PROFILE_OFF" | "SCOPE_VERIFIED";
  organizationIds: string[];
  propertyIds: string[];
};

function uniqueSorted(values: readonly string[]) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  ).sort();
}

function missingIds(
  expectedIds: readonly string[],
  foundIds: readonly string[]
) {
  const found = new Set(foundIds);
  return expectedIds.filter((id) => !found.has(id));
}

/**
 * Read-only E12 runtime preflight.
 *
 * E11 certifies that every enabled E2-E10 stage uses one activation profile
 * and one tenant/property scope. E12 verifies that the configured scope still
 * resolves to the expected persisted tenants/properties immediately before
 * reservation.worker enters the APMS Guest Journey stages.
 *
 * The function never mutates Prisma state and never calls a provider. Any
 * missing or cross-tenant scope throws so the caller can fail closed before
 * executing an APMS stage.
 */
export async function verifyGuestJourneyRuntimeScope(
  prisma: GuestJourneyRuntimeScopePrisma,
  config: GuestJourneyActivationControlPlaneConfig
): Promise<GuestJourneyRuntimeScopePreflight> {
  const organizationIds = uniqueSorted(
    config.scope.organizationIds
  );
  const propertyIds = uniqueSorted(
    config.scope.propertyIds
  );

  if (config.profile === "off") {
    return {
      version: GUEST_JOURNEY_RUNTIME_ENFORCEMENT_VERSION,
      profile: config.profile,
      enforced: false,
      reason: "PROFILE_OFF",
      organizationIds,
      propertyIds,
    };
  }

  if (
    organizationIds.length === 0 &&
    propertyIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_RUNTIME_SCOPE_REQUIRED: enabled activation profiles require tenant/property scope"
    );
  }

  const [organizations, properties] = await Promise.all([
    organizationIds.length > 0
      ? prisma.organization.findMany({
          where: {
            id: {
              in: organizationIds,
            },
          },
          select: {
            id: true,
          },
        })
      : Promise.resolve([]),
    propertyIds.length > 0
      ? prisma.property.findMany({
          where: {
            id: {
              in: propertyIds,
            },
          },
          select: {
            id: true,
            organizationId: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const missingOrganizationIds = missingIds(
    organizationIds,
    organizations.map((organization) => organization.id)
  );

  if (missingOrganizationIds.length > 0) {
    throw new Error(
      `GUEST_JOURNEY_RUNTIME_ORGANIZATION_SCOPE_NOT_FOUND:${missingOrganizationIds.join(",")}`
    );
  }

  const missingPropertyIds = missingIds(
    propertyIds,
    properties.map((property) => property.id)
  );

  if (missingPropertyIds.length > 0) {
    throw new Error(
      `GUEST_JOURNEY_RUNTIME_PROPERTY_SCOPE_NOT_FOUND:${missingPropertyIds.join(",")}`
    );
  }

  if (organizationIds.length > 0) {
    const allowedOrganizations = new Set(
      organizationIds
    );

    for (const property of properties) {
      if (
        !allowedOrganizations.has(
          property.organizationId
        )
      ) {
        throw new Error(
          `GUEST_JOURNEY_RUNTIME_TENANT_PROPERTY_SCOPE_MISMATCH:${property.id}:${property.organizationId}`
        );
      }
    }
  }

  return {
    version: GUEST_JOURNEY_RUNTIME_ENFORCEMENT_VERSION,
    profile: config.profile,
    enforced: true,
    reason: "SCOPE_VERIFIED",
    organizationIds,
    propertyIds,
  };
}
