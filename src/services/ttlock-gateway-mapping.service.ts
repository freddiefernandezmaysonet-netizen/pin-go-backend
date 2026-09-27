import type { PrismaClient } from "@prisma/client";

export async function learnTtlockGatewayMapping(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    lockId: string;
    gatewayId: number | null;
    gatewayMac?: string | null;
    isOnline?: boolean | null;
    observedAt?: Date;
    source: string;
  }
) {
  if (!input.gatewayId) {
    return {
      status: "NO_GATEWAY" as const,
      gatewayRecordId: null,
      providerRequests: 0,
    };
  }

  const observedAt = input.observedAt ?? new Date();

  const gateway = await prisma.ttlockGateway.upsert({
    where: {
      organizationId_ttlockGatewayId: {
        organizationId: input.organizationId,
        ttlockGatewayId: input.gatewayId,
      },
    },
    create: {
      organizationId: input.organizationId,
      ttlockGatewayId: input.gatewayId,
      gatewayMac: input.gatewayMac ?? null,
      isOnline: input.isOnline ?? null,
      lastEventAt: observedAt,
      lastOnlineAt:
        input.isOnline === true ? observedAt : null,
      lastOfflineAt:
        input.isOnline === false ? observedAt : null,
      source: input.source,
      rawPayload: {
        learnedFromLockId: input.lockId,
      },
    },
    update: {
      gatewayMac: input.gatewayMac ?? undefined,
      ...(input.isOnline === undefined
        ? {}
        : {
            isOnline: input.isOnline,
            lastEventAt: observedAt,
            ...(input.isOnline === true
              ? { lastOnlineAt: observedAt }
              : input.isOnline === false
                ? { lastOfflineAt: observedAt }
                : {}),
          }),
      source: input.source,
    },
    select: { id: true },
  });

  await prisma.lock.update({
    where: { id: input.lockId },
    data: { ttlockGatewayId: gateway.id },
  });

  return {
    status: "MAPPED" as const,
    gatewayRecordId: gateway.id,
    providerRequests: 0,
  };
}
