import {
  DashboardUserRole,
  PrismaClient,
} from "@prisma/client";

export type GuestReplyToSource =
  | "ORGANIZATION_SETTING"
  | "PRIMARY_ADMIN"
  | "PIN_GO_SUPPORT";

export type OrganizationGuestReplyTo = {
  email: string;
  source: GuestReplyToSource;
};

const PIN_GO_SUPPORT_EMAIL = "support@pin-ngo.com";

export async function resolveOrganizationGuestReplyTo(
  prisma: PrismaClient,
  organizationId: string
): Promise<OrganizationGuestReplyTo> {
  const cleanOrganizationId = String(
    organizationId ?? ""
  ).trim();

  if (!cleanOrganizationId) {
    throw new Error(
      "GUEST_REPLY_TO_ORGANIZATION_ID_REQUIRED"
    );
  }

  const organization =
    await prisma.organization.findUnique({
      where: {
        id: cleanOrganizationId,
      },
      select: {
        guestCommunicationEmail: true,
        dashboardUsers: {
          where: {
            isActive: true,
            role: {
              in: [
                DashboardUserRole.ORG_ADMIN,
                DashboardUserRole.ADMIN,
              ],
            },
          },
          orderBy: {
            createdAt: "asc",
          },
          take: 1,
          select: {
            email: true,
          },
        },
      },
    });

  if (!organization) {
    throw new Error(
      "GUEST_REPLY_TO_ORGANIZATION_NOT_FOUND"
    );
  }

  const configuredEmail = normalizeEmail(
    organization.guestCommunicationEmail
  );

  if (configuredEmail) {
    return {
      email: configuredEmail,
      source: "ORGANIZATION_SETTING",
    };
  }

  const primaryAdminEmail = normalizeEmail(
    organization.dashboardUsers[0]?.email
  );

  if (primaryAdminEmail) {
    return {
      email: primaryAdminEmail,
      source: "PRIMARY_ADMIN",
    };
  }

  return {
    email: PIN_GO_SUPPORT_EMAIL,
    source: "PIN_GO_SUPPORT",
  };
}

function normalizeEmail(value: unknown) {
  const email = String(value ?? "")
    .trim()
    .toLowerCase();

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }

  return email;
}
