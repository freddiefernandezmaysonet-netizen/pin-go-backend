import { PrismaClient, SubscriptionStatus } from "@prisma/client";

export async function assertLockCapacity(
  prisma: PrismaClient,
  orgId: string,
  additional = 1
) {
  // 1️⃣ Cupo (entitled) viene de la suscripción
  const sub = await prisma.subscription.findUnique({
    where: { organizationId: orgId },
    select: { entitledLocks: true, status: true },
  });

  const status = sub?.status ?? null;
  const entitled = sub?.entitledLocks ?? 0;

  const allowedStatuses: SubscriptionStatus[] = [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.TRIALING,
  ];

  if (!sub || !allowedStatuses.includes(sub.status)) {
    return {
      ok: false,
      entitled,
      used: 0,
      remaining: entitled,
      status,
      error: "SUBSCRIPTION_INACTIVE" as const,
    };
  }

  // 2️⃣ Locks usadas
  const used = await prisma.lock.count({
    where: {
      isActive: true,
      property: { organizationId: orgId },
    },
  });

  const remaining = entitled - used;

  if (used + additional > entitled) {
    return {
      ok: false,
      entitled,
      used,
      remaining,
      status,
      error: "LOCK_LIMIT_REACHED" as const,
    };
  }

  return {
    ok: true,
    entitled,
    used,
    remaining,
    status,
  };
}