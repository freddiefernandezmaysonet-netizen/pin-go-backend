import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/auth.js";
import { APP_REVIEW_EMAIL, APP_REVIEW_ORGANIZATION_NAME, APP_REVIEW_ORGANIZATION_SLUG } from "../auth/app-review-access.js";

export async function provisionAppReviewAccount(
  db: Pick<PrismaClient, "$transaction">,
  input: { actorUserId: string; apply: boolean },
) {
  if (!input.actorUserId.trim()) throw new Error("APP_REVIEW_OPERATOR_REQUIRED");
  return db.$transaction(async tx => {
    const actor = await tx.dashboardUser.findUnique({ where: { id: input.actorUserId },
      select: { id: true, isActive: true, role: true } });
    if (!actor?.isActive || actor.role !== "PLATFORM_ADMIN") {
      throw new Error("APP_REVIEW_PLATFORM_ADMIN_REQUIRED");
    }
    const existingUser = await tx.dashboardUser.findUnique({ where: { email: APP_REVIEW_EMAIL }, select: { id: true } });
    const existingOrg = await tx.organization.findUnique({ where: { slug: APP_REVIEW_ORGANIZATION_SLUG }, select: { id: true } });
    if (existingUser || existingOrg) throw new Error("APP_REVIEW_ACCOUNT_ALREADY_EXISTS_INSPECT_MANUALLY");
    const plan = { email: APP_REVIEW_EMAIL, organizationName: APP_REVIEW_ORGANIZATION_NAME,
      organizationSlug: APP_REVIEW_ORGANIZATION_SLUG, role: "ORG_ADMIN" as const,
      actorUserId: actor.id };
    if (!input.apply) return { applied: false as const, ...plan };
    // Unknown bootstrap password: no password is accepted as a CLI argument or logged.
    // The owner must set a password through the existing email recovery flow.
    const passwordHash = await hashPassword(randomBytes(48).toString("base64url"));
    const organization = await tx.organization.create({ data: {
      name: plan.organizationName, slug: plan.organizationSlug,
      publicBookingEnabled: false, pinAIEnabled: false,
      dashboardUsers: { create: { email: plan.email, fullName: "Apple App Review",
        role: plan.role, passwordHash, isActive: true, tokenVersion: 1 } },
    }, select: { id: true, dashboardUsers: { select: { id: true } } } });
    const userId = organization.dashboardUsers[0]?.id;
    if (!userId) throw new Error("APP_REVIEW_USER_CREATION_FAILED");
    return { applied: true as const, ...plan, organizationId: organization.id, userId };
  }, { isolationLevel: "Serializable" });
}
