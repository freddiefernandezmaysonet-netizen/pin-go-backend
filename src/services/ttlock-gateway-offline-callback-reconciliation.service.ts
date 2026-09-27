import type { PrismaClient } from "@prisma/client";

import { recordTtlockGatewayObservation } from "./ttlock-gateway-health.service";

type JsonRecord = Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function payloadContainsGatewayId(
  value: unknown,
  gatewayId: number,
  depth = 0
): boolean {
  if (depth > 6 || value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) =>
      payloadContainsGatewayId(item, gatewayId, depth + 1)
    );
  }

  if (typeof value !== "object") {
    return false;
  }

  const record = value as JsonRecord;

  if (finiteNumber(record.gatewayId) === gatewayId) {
    return true;
  }

  return Object.values(record).some((item) =>
    payloadContainsGatewayId(item, gatewayId, depth + 1)
  );
}

export async function reconcileTtlockGatewayOfflineCallback(
  prisma: PrismaClient,
  input: {
    gatewayId: number;
    occurredAt?: Date;
  }
) {
  const occurredAt = input.occurredAt ?? new Date();

  const existingGateways = await prisma.tTLockGateway.findMany({
    where: {
      ttlockGatewayId: input.gatewayId,
    },
    select: {
      id: true,
      organizationId: true,
      isOnline: true,
    },
  });

  if (existingGateways.length > 1) {
    return {
      status: "AMBIGUOUS_GATEWAY_MAPPING" as const,
      mappedLocks: 0,
      providerRequests: 0,
    };
  }

  const telemetryLocks = await prisma.lock.findMany({
    where: {
      isActive: true,
      deviceHealth: {
        isNot: null,
      },
    },
    select: {
      id: true,
      property: {
        select: {
          organizationId: true,
        },
      },
      deviceHealth: {
        select: {
          rawPayload: true,
          gatewayRawPayload: true,
        },
      },
    },
  });

  const locallyMatched = telemetryLocks.filter((lock) => {
    const health = lock.deviceHealth;
    if (!health) return false;

    return (
      payloadContainsGatewayId(
        health.rawPayload,
        input.gatewayId
      ) ||
      payloadContainsGatewayId(
        health.gatewayRawPayload,
        input.gatewayId
      )
    );
  });

  const matchedOrganizationIds = [
    ...new Set(
      locallyMatched.map(
        (lock) => lock.property.organizationId
      )
    ),
  ];

  const existingGateway = existingGateways[0] ?? null;

  let organizationId =
    existingGateway?.organizationId ?? null;

  if (!organizationId) {
    if (matchedOrganizationIds.length === 0) {
      return {
        status: "NO_LOCAL_GATEWAY_MAPPING" as const,
        mappedLocks: 0,
        providerRequests: 0,
      };
    }

    if (matchedOrganizationIds.length > 1) {
      return {
        status: "AMBIGUOUS_GATEWAY_MAPPING" as const,
        mappedLocks: 0,
        providerRequests: 0,
      };
    }

    organizationId =
      matchedOrganizationIds[0] ?? null;
  }

  if (!organizationId) {
    return {
      status: "NO_LOCAL_GATEWAY_MAPPING" as const,
      mappedLocks: 0,
      providerRequests: 0,
    };
  }

  if (
    matchedOrganizationIds.some(
      (candidate) => candidate !== organizationId
    )
  ) {
    return {
      status: "AMBIGUOUS_GATEWAY_MAPPING" as const,
      mappedLocks: 0,
      providerRequests: 0,
    };
  }

  const duplicateState =
    existingGateway?.isOnline === false;

  const gateway =
    await recordTtlockGatewayObservation(prisma, {
      organizationId,
      ttlockGatewayId: input.gatewayId,
      isOnline: false,
      occurredAt,
      source: "TTLOCK_CALLBACK",
      rawPayload: {
        telemetryType: "GATEWAY_CALLBACK",
        gatewayId: input.gatewayId,
        isOnline: false,
      },
    });

  const matchingLockIds = locallyMatched
    .filter(
      (lock) =>
        lock.property.organizationId ===
        organizationId
    )
    .map((lock) => lock.id);

  if (matchingLockIds.length > 0) {
    await prisma.lock.updateMany({
      where: {
        id: {
          in: matchingLockIds,
        },
        property: {
          organizationId,
        },
      },
      data: {
        ttlockGatewayRecordId: gateway.id,
      },
    });
  }

  return {
    status: duplicateState
      ? ("DUPLICATE_STATE" as const)
      : ("UPDATED" as const),
    mappedLocks: matchingLockIds.length,
    providerRequests: 0,
  };
}
