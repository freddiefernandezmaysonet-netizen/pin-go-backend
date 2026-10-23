import type { PrismaClient } from "@prisma/client";

export const APP_REVIEW_EMAIL = "apple-review@pin-ngo.com";
export const APP_REVIEW_ORGANIZATION_SLUG = "pin-go-app-review";
export const APP_REVIEW_ORGANIZATION_NAME = "Pin&Go App Review";
type Environment = Readonly<Record<string, string | undefined>>;
export type ReviewIdentity = {
  id: string; organizationId: string; email: string; role: string;
  isActive: boolean; tokenVersion: number;
  organization: { slug: string | null } | null;
};

// This is an operator-configured exception, never a client request flag.
// Call only AFTER the normal active-account and password checks succeed.
export function appReviewDeadline(user: ReviewIdentity, env: Environment, now = new Date()): Date | null {
  if (env.PINGO_APP_REVIEW_ENABLED !== "true" || env.PINGO_SESSION_MODE !== "ENFORCE" ||
      !env.PINGO_APP_REVIEW_USER_ID || !env.PINGO_APP_REVIEW_ORGANIZATION_ID ||
      user.id !== env.PINGO_APP_REVIEW_USER_ID ||
      user.organizationId !== env.PINGO_APP_REVIEW_ORGANIZATION_ID ||
      user.email !== APP_REVIEW_EMAIL || user.role !== "ORG_ADMIN" || !user.isActive ||
      user.organization?.slug !== APP_REVIEW_ORGANIZATION_SLUG) return null;
  const raw = env.PINGO_APP_REVIEW_EXPIRES_AT ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) return null;
  const deadline = new Date(raw);
  if (!Number.isFinite(deadline.getTime()) || deadline.toISOString() !== raw ||
      deadline.getTime() <= now.getTime() ||
      deadline.getTime() - now.getTime() > 30 * 24 * 60 * 60 * 1000) return null;
  return deadline;
}

export async function createAppReviewSession(
  db: Pick<PrismaClient, "$transaction">, user: ReviewIdentity,
  env: Environment, userAgent: string | null, now = new Date(),
): Promise<string | null> {
  const deadline = appReviewDeadline(user, env, now);
  if (!deadline) return null;
  return db.$transaction(async tx => {
    // Do not exempt an organization connected to commercial services or locks.
    const isolated = await tx.organization.findFirst({ where: {
      id: user.organizationId, slug: APP_REVIEW_ORGANIZATION_SLUG,
      publicBookingEnabled: false, stripeCustomerId: null, stripeConnectAccountId: null,
      ttlockAuth: { is: null }, subscriptions: { is: null },
      pmsConnections: { none: {} },
      properties: { none: { locks: { some: {} } } },
      dashboardUsers: {
        some: { id: user.id, tokenVersion: user.tokenVersion },
        every: { id: user.id, email: APP_REVIEW_EMAIL, role: "ORG_ADMIN", isActive: true },
      },
    }, select: { id: true } });
    if (!isolated) throw new Error("APP_REVIEW_ORGANIZATION_NOT_ISOLATED");
    const session = await tx.authSession.create({ data: {
      userId: user.id, organizationId: user.organizationId, tokenVersion: user.tokenVersion,
      authenticatedAt: now, lastActivityAt: now,
      absoluteExpiresAt: new Date(Math.min(deadline.getTime(), now.getTime() + 24 * 60 * 60 * 1000)),
      sessionPolicy: "LEGACY", userAgent,
    }, select: { id: true } });
    await tx.securityEvent.create({ data: {
      userId: user.id, organizationId: user.organizationId, type: "AUTH_SESSION_CREATED", userAgent,
      metadata: { reason: "APP_REVIEW_TEMPORARY_EXCEPTION", mfaBypassed: true,
        sessionId: session.id, exceptionExpiresAt: deadline.toISOString() },
    } });
    return session.id;
  }, { isolationLevel: "Serializable" });
}
