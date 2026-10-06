import type { PrismaClient } from "@prisma/client";
import { resolveOrganizationPrimaryAdmin, type OrganizationPrimaryAdmin } from "./organization-guest-email.service.js";

// Demo-only recipient resolution. Commercial booking policy stays unchanged.
// A platform operator is eligible only when that exact active account created
// this Demo in its own organization. Never select an arbitrary organization user.
export async function resolveInternalDemoPrimaryAdmin(
  db: PrismaClient, organizationId: string, actorUserId: unknown,
): Promise<OrganizationPrimaryAdmin | null> {
  const principal = await resolveOrganizationPrimaryAdmin(db, organizationId);
  if (principal) return principal;
  if (typeof actorUserId !== "string" || !actorUserId.trim()) return null;
  const actor = await db.dashboardUser.findFirst({ where: {
    id: actorUserId, organizationId, isActive: true, role: "PLATFORM_ADMIN",
  }, select: { email: true, fullName: true } });
  const email = actor?.email.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { email, fullName: actor?.fullName ?? null };
}
