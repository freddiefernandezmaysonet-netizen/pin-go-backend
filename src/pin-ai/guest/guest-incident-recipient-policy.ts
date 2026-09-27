import type { Prisma } from "@prisma/client";

// Match the existing requireOrgAdmin roles, but only within the incident's
// organization. PLATFORM_ADMIN is never a cross-tenant notification fallback.
// Use the same predicate at enqueue time and immediately before delivery.
export function guestIncidentRecipientWhere(organizationId: string): Prisma.DashboardUserWhereInput {
  if (!organizationId.trim()) throw new Error("PIN_AI_INCIDENT_RECIPIENT_SCOPE_REQUIRED");
  return {
    organizationId,
    isActive: true,
    role: { in: ["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"] },
  };
}
