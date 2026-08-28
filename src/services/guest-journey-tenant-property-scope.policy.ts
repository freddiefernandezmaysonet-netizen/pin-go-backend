import { Prisma } from "@prisma/client";

export const GUEST_JOURNEY_TENANT_PROPERTY_SCOPE_VERSION =
  "guest_journey_tenant_property_scope_v1" as const;

export type GuestJourneyTenantPropertyScope = {
  organizationIds: readonly string[];
  propertyIds: readonly string[];
};

function uniqueSorted(
  values: readonly string[]
): string[] {
  return Array.from(
    new Set(
      values
        .map((value) =>
          String(value ?? "").trim()
        )
        .filter(Boolean)
    )
  ).sort();
}

export function normalizeGuestJourneyTenantPropertyScope(
  scope: GuestJourneyTenantPropertyScope
): {
  organizationIds: string[];
  propertyIds: string[];
} {
  return {
    organizationIds: uniqueSorted(
      scope.organizationIds
    ),
    propertyIds: uniqueSorted(
      scope.propertyIds
    ),
  };
}

export function assertGuestJourneyTenantPropertyScope(
  input: {
    enabled: boolean;
    scope: GuestJourneyTenantPropertyScope;
    errorCode: string;
  }
): void {
  if (!input.enabled) return;

  const normalized =
    normalizeGuestJourneyTenantPropertyScope(
      input.scope
    );

  if (
    normalized.organizationIds.length === 0
  ) {
    throw new Error(input.errorCode);
  }
}

export function isGuestJourneyTenantPropertyScope(
  scope: GuestJourneyTenantPropertyScope,
  input: {
    organizationId?: string | null;
    propertyId?: string | null;
  }
): boolean {
  const normalized =
    normalizeGuestJourneyTenantPropertyScope(
      scope
    );
  const organizationId = String(
    input.organizationId ?? ""
  ).trim();
  const propertyId = String(
    input.propertyId ?? ""
  ).trim();

  if (
    !organizationId ||
    !normalized.organizationIds.includes(
      organizationId
    )
  ) {
    return false;
  }

  if (normalized.propertyIds.length === 0) {
    return true;
  }

  return (
    propertyId.length > 0 &&
    normalized.propertyIds.includes(propertyId)
  );
}

export function buildGuestJourneyReservationScopeWhere(
  scope: GuestJourneyTenantPropertyScope
): Prisma.ReservationWhereInput {
  const normalized =
    normalizeGuestJourneyTenantPropertyScope(
      scope
    );

  if (
    normalized.organizationIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_TENANT_ORGANIZATION_SCOPE_REQUIRED"
    );
  }

  return {
    property: {
      is: {
        organizationId: {
          in: normalized.organizationIds,
        },
      },
    },
    ...(normalized.propertyIds.length > 0
      ? {
          propertyId: {
            in: normalized.propertyIds,
          },
        }
      : {}),
  };
}

export function buildGuestJourneyCoordinationIntentScopeWhere(
  scope: GuestJourneyTenantPropertyScope
): Prisma.GuestJourneyCoordinationIntentWhereInput {
  return {
    reservation: {
      is: buildGuestJourneyReservationScopeWhere(
        scope
      ),
    },
  };
}
