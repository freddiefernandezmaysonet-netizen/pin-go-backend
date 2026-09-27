import type { PrismaClient } from "@prisma/client";

export type TtlockGatewayObservationInput = {
  organizationId: string;
  ttlockGatewayId: number;
  isOnline: boolean | null;
  lockId?: string | null;
  gatewayMac?: string | null;
  gatewayName?: string | null;
  occurredAt?: Date;
  source: string;
  rawPayload?: unknown;
  stateWriteMode?:
    | "AUTHORITATIVE"
    | "INITIAL_ONLY";
};

export async function recordTtlockGatewayObservation(
  prisma: PrismaClient,
  input: TtlockGatewayObservationInput
) {
  const occurredAt =
    input.occurredAt ?? new Date();
  const stateWriteMode =
    input.stateWriteMode ??
    "AUTHORITATIVE";

  const gateway =
    await prisma.tTLockGateway.upsert({
      where: {
        organizationId_ttlockGatewayId: {
          organizationId:
            input.organizationId,
          ttlockGatewayId:
            input.ttlockGatewayId,
        },
      },
      create: {
        organizationId:
          input.organizationId,
        ttlockGatewayId:
          input.ttlockGatewayId,
        gatewayMac:
          input.gatewayMac ?? null,
        gatewayName:
          input.gatewayName ?? null,
        isOnline: input.isOnline,
        lastEventAt: occurredAt,
        lastSeenOnlineAt:
          input.isOnline === true
            ? occurredAt
            : null,
        lastSeenOfflineAt:
          input.isOnline === false
            ? occurredAt
            : null,
        source: input.source,
        rawPayload:
          input.rawPayload === undefined
            ? undefined
            : (input.rawPayload as any),
      },
      update:
        stateWriteMode ===
        "INITIAL_ONLY"
          ? {
              gatewayMac:
                input.gatewayMac !==
                undefined
                  ? input.gatewayMac
                  : undefined,
              gatewayName:
                input.gatewayName !==
                undefined
                  ? input.gatewayName
                  : undefined,
            }
          : {
              gatewayMac:
                input.gatewayMac !==
                undefined
                  ? input.gatewayMac
                  : undefined,
              gatewayName:
                input.gatewayName !==
                undefined
                  ? input.gatewayName
                  : undefined,
              isOnline:
                input.isOnline,
              lastEventAt:
                occurredAt,
              lastSeenOnlineAt:
                input.isOnline === true
                  ? occurredAt
                  : undefined,
              lastSeenOfflineAt:
                input.isOnline === false
                  ? occurredAt
                  : undefined,
              source:
                input.source,
              rawPayload:
                input.rawPayload ===
                undefined
                  ? undefined
                  : (input.rawPayload as any),
            },
    });

  if (input.lockId) {
    await prisma.lock.updateMany({
      where: {
        id: input.lockId,
        property: {
          organizationId:
            input.organizationId,
        },
      },
      data: {
        ttlockGatewayRecordId:
          gateway.id,
      },
    });
  }

  return gateway;
}
