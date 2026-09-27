import type { PrismaClient } from "@prisma/client";

export async function learnTtlockGatewayMapping(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    lockId: string;
    gatewayId: number | null;
    gatewayMac?: string | null;
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
      isOnline: null,
      lastEventAt: null,
      lastOnlineAt: null,
      lastOfflineAt: null,
      source: input.source,
      rawPayload: {
        learnedFromLockId: input.lockId,
      },
    },
    update: {
      gatewayMac: input.gatewayMac ?? undefined,
    },
    select: { id: true },
  });

  await prisma.lock.update({
    where: { id: input.lockId },
    data: { ttlockGatewayRecordId: gateway.id },
  });

  return {
    status: "MAPPED" as const,
    gatewayRecordId: gateway.id,
    providerRequests: 0,
  };
}


export async function resolveUniqueMappedTtlockGateway(
  prisma: PrismaClient,
  gatewayId: number
) {
  const matches = await prisma.ttlockGateway.findMany({
    where: {
      ttlockGatewayId: gatewayId,
    },
    select: {
      id: true,
      organizationId: true,
      ttlockGatewayId: true,
    },
    take: 2,
  });

  if (matches.length === 0) {
    return {
      status: "UNKNOWN_GATEWAY" as const,
      gateway: null,
      providerRequests: 0,
    };
  }

  if (matches.length > 1) {
    return {
      status: "AMBIGUOUS_GATEWAY" as const,
      gateway: null,
      providerRequests: 0,
    };
  }

  return {
    status: "RESOLVED" as const,
    gateway: matches[0],
    providerRequests: 0,
  };
}
