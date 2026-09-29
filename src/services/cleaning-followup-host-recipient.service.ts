import { DashboardUserRole } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

function normalizeEmails(users: Array<{ email: string | null }>) {
  return [
    ...new Set(
      users
        .map((user) =>
          String(user.email ?? "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
}

export async function resolveCleaningHostAttentionRecipients(
  prisma: PrismaClient,
  organizationId: string,
): Promise<string[]> {
  const cleanOrganizationId = organizationId.trim();
  if (!cleanOrganizationId) {
    throw new Error("CLEANING_HOST_ATTENTION_ORG_REQUIRED");
  }

  for (const role of [
    DashboardUserRole.ORG_ADMIN,
    DashboardUserRole.ADMIN,
  ]) {
    const users = await prisma.dashboardUser.findMany({
      where: {
        organizationId: cleanOrganizationId,
        isActive: true,
        role,
      },
      select: { email: true },
      orderBy: { createdAt: "asc" },
    });

    const emails = normalizeEmails(users);
    if (emails.length) return emails;
  }

  const activeOrganizationUsers =
    await prisma.dashboardUser.findMany({
      where: {
        organizationId: cleanOrganizationId,
        isActive: true,
      },
      select: { email: true },
      orderBy: { createdAt: "asc" },
    });

  return normalizeEmails(activeOrganizationUsers);
}
