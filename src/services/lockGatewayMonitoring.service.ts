import type { PrismaClient } from "@prisma/client";

export const LOCK_GATEWAY_POLICY_TYPE =
  "TTLOCK_GATEWAY_MONITORING";
export const LOCK_GATEWAY_POLICY_PROVIDER =
  "PIN_GO";
const LOCK_GATEWAY_EXTERNAL_ID_PREFIX =
  "LOCK_GATEWAY:";

export type GatewayMonitoringMode =
  | "ENABLED"
  | "DISABLED"
  | "LEGACY_UNCONFIGURED";

type GatewayPolicyRow = {
  id: string;
  externalId: string | null;
  isActive: boolean;
  updatedAt: Date;
};

function policyExternalId(lockId: string) {
  return `${LOCK_GATEWAY_EXTERNAL_ID_PREFIX}${lockId}`;
}

function lockIdFromPolicyExternalId(
  externalId: string | null
) {
  if (
    !externalId ||
    !externalId.startsWith(
      LOCK_GATEWAY_EXTERNAL_ID_PREFIX
    )
  ) {
    return null;
  }

  const lockId = externalId.slice(
    LOCK_GATEWAY_EXTERNAL_ID_PREFIX.length
  );

  return lockId || null;
}

export function gatewayMonitoringModeFromPolicy(
  policy?: Pick<GatewayPolicyRow, "isActive"> | null
): GatewayMonitoringMode {
  if (!policy) return "LEGACY_UNCONFIGURED";
  return policy.isActive ? "ENABLED" : "DISABLED";
}

export function gatewayMonitoringEnabledForWorker(
  mode: GatewayMonitoringMode
) {
  // Transitional safety: existing locks without an explicit policy preserve
  // their current behavior until the host classifies them in Pin&Go.
  return mode !== "DISABLED";
}

export async function loadGatewayMonitoringPolicies(
  prisma: PrismaClient,
  input: {
    organizationId?: string;
    lockIds: string[];
  }
): Promise<Map<string, GatewayPolicyRow>> {
  const policies = new Map<string, GatewayPolicyRow>();

  if (input.lockIds.length === 0) {
    return policies;
  }

  const rows = await prisma.propertyDevice.findMany({
    where: {
      ...(input.organizationId
        ? { organizationId: input.organizationId }
        : {}),
      type: LOCK_GATEWAY_POLICY_TYPE,
      provider: LOCK_GATEWAY_POLICY_PROVIDER,
      externalId: {
        in: input.lockIds.map(policyExternalId),
      },
    },
    select: {
      id: true,
      externalId: true,
      isActive: true,
      updatedAt: true,
    },
  });

  for (const row of rows) {
    const lockId = lockIdFromPolicyExternalId(
      row.externalId
    );

    if (lockId) {
      policies.set(lockId, row);
    }
  }

  return policies;
}

export async function setGatewayMonitoringPolicy(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    propertyId: string;
    lockId: string;
    enabled: boolean;
    configuredBy?: string | null;
  }
) {
  const externalId = policyExternalId(
    input.lockId
  );

  const existing = await prisma.propertyDevice.findFirst({
    where: {
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      type: LOCK_GATEWAY_POLICY_TYPE,
      provider: LOCK_GATEWAY_POLICY_PROVIDER,
      externalId,
    },
    select: {
      id: true,
    },
  });

  const metadata = {
    lockId: input.lockId,
    gatewayInstalled: input.enabled,
    configuredBy: input.configuredBy ?? null,
    configuredAt: new Date().toISOString(),
    source: "PIN_GO_LOCK_CONFIGURATION",
  };

  if (existing) {
    return prisma.propertyDevice.update({
      where: {
        id: existing.id,
      },
      data: {
        isActive: input.enabled,
        metadata,
      },
    });
  }

  return prisma.propertyDevice.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      name: "TTLock gateway monitoring",
      type: LOCK_GATEWAY_POLICY_TYPE,
      provider: LOCK_GATEWAY_POLICY_PROVIDER,
      externalId,
      isActive: input.enabled,
      metadata,
    },
  });
}
