import { DashboardUserRole, type PrismaClient } from "@prisma/client";
import { resolveOrganizationPrimaryAdmin } from "./organization-guest-email.service.js";

export async function resolveDirectBookingHostRecipient(
  prisma: PrismaClient,
  organizationId: string
) {
  const scopedOrganizationId = String(organizationId ?? "").trim();
  const primary = await resolveOrganizationPrimaryAdmin(prisma, scopedOrganizationId);
  if (primary) return primary;

  // Legacy and platform administrators qualify only in their own organization.
  // Never fall back to members or search administrators across organizations.
  for (const role of [DashboardUserRole.ADMIN, DashboardUserRole.PLATFORM_ADMIN]) {
    const user = await prisma.dashboardUser.findFirst({
      where: { organizationId: scopedOrganizationId, isActive: true, role },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { email: true, fullName: true },
    });
    const email = String(user?.email ?? "").trim().toLowerCase();
    if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { email, fullName: user?.fullName ?? null };
    }
  }
  return null;
}
