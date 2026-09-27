import type { PrismaClient } from "@prisma/client";

import { upsertDeviceHealth } from "./deviceHealth.service";
import { getOrgTtlockAccessToken } from "./ttlock/ttlock.org-auth";

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;

type JsonRecord = Record<string, unknown>;

type GatewayOwner = {
  organizationId: string;
  accessToken: string;
  isOnline: boolean;
};

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

async function postForm(url: string, body: URLSearchParams) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });

    const text = await response.text();
    let data: JsonRecord;

    try {
      data = JSON.parse(text) as JsonRecord;
    } catch {
      throw new Error(
        `TTLock callback reconciliation returned invalid JSON status=${response.status}`
      );
    }

    const errcode = finiteNumber(data.errcode);
    if (!response.ok || (errcode !== null && errcode !== 0)) {
      throw new Error(
        `TTLock callback reconciliation failed status=${response.status} errcode=${errcode ?? "UNKNOWN"}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function findGatewayOwner(
  prisma: PrismaClient,
  gatewayId: number
): Promise<GatewayOwner | null> {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";

  const authRows = await prisma.tTLockAuth.findMany({
    select: { organizationId: true },
  });

  const matches: GatewayOwner[] = [];

  for (const auth of authRows) {
    const accessToken = await getOrgTtlockAccessToken(
      prisma,
      auth.organizationId
    );

    let pageNo = 1;

    while (true) {
      const data = await postForm(
        `${base}/v3/gateway/list`,
        new URLSearchParams({
          clientId,
          accessToken,
          pageNo: String(pageNo),
          pageSize: String(PAGE_SIZE),
          date: String(Date.now()),
        })
      );

      const list = Array.isArray(data.list) ? data.list : [];
      const found = list.find((item) => {
        if (!item || typeof item !== "object") return false;
        return finiteNumber((item as JsonRecord).gatewayId) === gatewayId;
      }) as JsonRecord | undefined;

      if (found) {
        const onlineValue = finiteNumber(found.isOnline);

        if (onlineValue !== 0 && onlineValue !== 1) {
          throw new Error(
            `TTLock gateway ${gatewayId} returned invalid isOnline`
          );
        }

        matches.push({
          organizationId: auth.organizationId,
          accessToken,
          isOnline: onlineValue === 1,
        });
        break;
      }

      const pages = finiteNumber(data.pages);
      if (
        list.length < PAGE_SIZE ||
        (pages !== null && pageNo >= pages)
      ) {
        break;
      }

      pageNo += 1;
    }
  }

  if (matches.length > 1) {
    throw new Error(
      `TTLock gateway ${gatewayId} matched multiple organizations`
    );
  }

  return matches[0] ?? null;
}

async function fetchGatewayLockIds(
  accessToken: string,
  gatewayId: number
): Promise<number[]> {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";

  const data = await postForm(
    `${base}/v3/gateway/listLock`,
    new URLSearchParams({
      clientId,
      accessToken,
      gatewayId: String(gatewayId),
      date: String(Date.now()),
    })
  );

  const list = Array.isArray(data.list) ? data.list : [];

  return list
    .map((item) =>
      item && typeof item === "object"
        ? finiteNumber((item as JsonRecord).lockId)
        : null
    )
    .filter((value): value is number => value !== null);
}

export async function reconcileTtlockGatewayOfflineCallback(
  prisma: PrismaClient,
  input: {
    gatewayId: number;
    occurredAt?: Date;
  }
) {
  const now = input.occurredAt ?? new Date();
  const owner = await findGatewayOwner(prisma, input.gatewayId);

  if (!owner) {
    return {
      status: "GATEWAY_NOT_FOUND" as const,
      matchedLocks: 0,
      updatedLocks: 0,
    };
  }

  if (owner.isOnline) {
    return {
      status: "CANONICAL_GATEWAY_ONLINE" as const,
      matchedLocks: 0,
      updatedLocks: 0,
    };
  }

  const ttlockLockIds = await fetchGatewayLockIds(
    owner.accessToken,
    input.gatewayId
  );

  if (ttlockLockIds.length === 0) {
    return {
      status: "NO_GATEWAY_LOCKS" as const,
      matchedLocks: 0,
      updatedLocks: 0,
    };
  }

  const locks = await prisma.lock.findMany({
    where: {
      isActive: true,
      ttlockLockId: { in: ttlockLockIds },
      property: {
        organizationId: owner.organizationId,
      },
    },
    select: {
      id: true,
      ttlockLockId: true,
      deviceHealth: {
        select: {
          gatewayDisconnectedSince: true,
        },
      },
    },
  });

  for (const lock of locks) {
    await upsertDeviceHealth(prisma, {
      lockId: lock.id,
      gatewayConnected: false,
      isOnline: false,
      gatewayLastCheckedAt: now,
      gatewayLastFailedAt: now,
      gatewayLastError:
        "TTLock gateway is offline (callback signal canonically verified)",
      gatewayProviderResponseAt: now,
      gatewayDisconnectedSince:
        lock.deviceHealth?.gatewayDisconnectedSince ?? now,
      lastEventAt: now,
      lastSyncAt: now,
      source: "TTLOCK_CALLBACK_VERIFIED",
      rawPayload: {
        telemetryType: "GATEWAY_CALLBACK_RECONCILIATION",
        gatewayId: input.gatewayId,
        ttlockLockId: lock.ttlockLockId,
        canonicalGatewayOnline: false,
      },
    });
  }

  return {
    status: "UPDATED" as const,
    matchedLocks: locks.length,
    updatedLocks: locks.length,
  };
}
