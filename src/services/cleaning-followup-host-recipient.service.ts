import { DashboardUserRole } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

export async function resolveCleaningHostAttentionRecipients(
  prisma: PrismaClient,
  organizationId: string,
): Promise<string[]> {
  if (!organizationId.trim()) throw new Error("CLEANING_HOST_ATTENTION_ORG_REQUIRED");
  for (const role of [DashboardUserRole.ORG_ADMIN, DashboardUserRole.ADMIN]) {
    const users = await prisma.dashboardUser.findMany({
      where: { organizationId, isActive: true, role },
      select: { email: true },
      orderBy: { createdAt: "asc" },
    });
    const emails = [...new Set(users.map(u => String(u.email ?? "").trim().toLowerCase()).filter(Boolean))];
    if (emails.length) return emails;
  }
  return [];
}
