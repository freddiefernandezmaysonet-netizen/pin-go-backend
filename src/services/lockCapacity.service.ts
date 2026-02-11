// src/services/lockCapacity.service.ts

import { PrismaClient, SubscriptionStatus } from "@prisma/client";

export async function assertLockCapacity(
  prisma: PrismaClient,
  orgId: string,
  additional = 1
) {
  // 1) Cupo (entitled) viene de la suscripción del ORG
  const sub = await prisma.subscription.findUnique({
    where: { organizationId: orgId }, // @unique -> findUnique perfecto
    select: { entitledLocks: true, status: true },
  });

  const status = sub?.status ?? null;
  const entitled = sub?.entitledLocks ?? 0;

  // (opcional) si quieres bloquear cuando no está activa
  // Ajusta los nombres reales de tu enum si difieren
  const allowedStatuses: SubscriptionStatus[] = [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.TRIALING,
  ];

  if (!sub || !allowedStatuses.includes(sub.status)) {
    return { ok: false, entitled, used: 0, status, error: "SUBSCRIPTION_INACTIVE" as const };
  }

  // 2) Usados = locks activos dentro del org
  const used = await prisma.lock.count({
    where: {
      isActive: true,
      property: { organizationId: orgId },
    },
  });

  if (used + additional > entitled) {
    return { ok: false, entitled, used, status };
  }

  return { ok: true, entitled, used, status };
}
