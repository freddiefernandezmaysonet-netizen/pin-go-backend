import type { PrismaClient } from "@prisma/client";

import { recordTtlockGatewayObservation } from "./ttlock-gateway-health.service";

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;

type JsonRecord = Record<string, unknown>;

type ProviderRequest = (input: {
  path: string;
  body: URLSearchParams;
}) => Promise<JsonRecord>;

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

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function defaultProviderRequest(input: {
  path: string;
  body: URLSearchParams;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const base =
      process.env.TTLOCK_API_BASE ??
      "https://api.sciener.com";

    const response = await fetch(
      `${base}${input.path}`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: input.body.toString(),
        signal: controller.signal,
      }
    );

    const text = await response.text();
    let data: JsonRecord;

    try {
      data = JSON.parse(text) as JsonRecord;
    } catch {
      throw new Error(
        `TTLOCK_GATEWAY_INVENTORY_INVALID_JSON:${response.status}`
      );
    }

    const errcode = finiteNumber(data.errcode);
    if (
      !response.ok ||
      (errcode !== null && errcode !== 0)
    ) {
      throw new Error(
        `TTLOCK_GATEWAY_INVENTORY_FAILED:status=${response.status}:errcode=${errcode ?? "UNKNOWN"}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncTtlockGatewayInventory(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    accessToken: string;
    now?: Date;
    providerRequest?: ProviderRequest;
  }
) {
  const now = input.now ?? new Date();
  const providerRequest =
    input.providerRequest ?? defaultProviderRequest;
  const clientId =
    process.env.TTLOCK_CLIENT_ID ?? "";

  let providerRequestCount = 0;
  let pageNo = 1;
  const gateways: Array<{
    ttlockGatewayId: number;
    gatewayMac: string | null;
    isOnline: boolean | null;
  }> = [];

  while (true) {
    providerRequestCount += 1;

    const data = await providerRequest({
      path: "/v3/gateway/list",
      body: new URLSearchParams({
        clientId,
        accessToken: input.accessToken,
        pageNo: String(pageNo),
        pageSize: String(PAGE_SIZE),
        date: String(now.getTime()),
      }),
    });

    const list = Array.isArray(data.list)
      ? data.list
      : [];

    for (const item of list) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as JsonRecord;
      const gatewayId =
        finiteNumber(record.gatewayId);

      if (gatewayId === null || gatewayId <= 0) {
        continue;
      }

      const onlineValue =
        finiteNumber(record.isOnline);

      gateways.push({
        ttlockGatewayId: gatewayId,
        gatewayMac:
          textValue(record.gatewayMac),
        isOnline:
          onlineValue === 1
            ? true
            : onlineValue === 0
              ? false
              : null,
      });
    }

    const pages = finiteNumber(data.pages);
    const total = finiteNumber(data.total);

    if (
      list.length < PAGE_SIZE ||
      (pages !== null && pageNo >= pages) ||
      (total !== null &&
        pageNo * PAGE_SIZE >= total)
    ) {
      break;
    }

    pageNo += 1;
  }

  const localLocks = await prisma.lock.findMany({
    where: {
      isActive: true,
      property: {
        organizationId:
          input.organizationId,
      },
    },
    select: {
      id: true,
      ttlockLockId: true,
    },
  });

  const localByTtlockId = new Map(
    localLocks.map((lock) => [
      lock.ttlockLockId,
      lock.id,
    ])
  );

  let mappedLocks = 0;

  for (const gateway of gateways) {
    const canonical =
      await recordTtlockGatewayObservation(
        prisma,
        {
          organizationId:
            input.organizationId,
          ttlockGatewayId:
            gateway.ttlockGatewayId,
          gatewayMac:
            gateway.gatewayMac,
          isOnline:
            gateway.isOnline,
          occurredAt: now,
          source:
            "TTLOCK_GATEWAY_INVENTORY_SYNC",
          rawPayload: {
            gatewayId:
              gateway.ttlockGatewayId,
            gatewayMac:
              gateway.gatewayMac,
            isOnline:
              gateway.isOnline,
          },
        }
      );

    providerRequestCount += 1;

    const lockData =
      await providerRequest({
        path: "/v3/gateway/listLock",
        body: new URLSearchParams({
          clientId,
          accessToken:
            input.accessToken,
          gatewayId: String(
            gateway.ttlockGatewayId
          ),
          date: String(now.getTime()),
        }),
      });

    const remoteLocks =
      Array.isArray(lockData.list)
        ? lockData.list
        : [];

    const localIds = remoteLocks
      .map((item) => {
        if (
          !item ||
          typeof item !== "object"
        ) {
          return null;
        }

        const ttlockLockId =
          finiteNumber(
            (item as JsonRecord).lockId
          );

        return ttlockLockId === null
          ? null
          : localByTtlockId.get(
              ttlockLockId
            ) ?? null;
      })
      .filter(
        (value): value is string =>
          Boolean(value)
      );

    if (localIds.length === 0) {
      continue;
    }

    const updated =
      await prisma.lock.updateMany({
        where: {
          id: {
            in: localIds,
          },
          property: {
            organizationId:
              input.organizationId,
          },
        },
        data: {
          ttlockGatewayRecordId:
            canonical.id,
        },
      });

    mappedLocks += updated.count;
  }

  return {
    gatewaysDiscovered:
      gateways.length,
    mappedLocks,
    providerRequestCount,
  };
}
