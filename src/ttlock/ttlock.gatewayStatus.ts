import {
  getDeviceHealthAccessTokenForTtlockLock,
} from "./ttlock.deviceHealth.auth";

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const MAX_GATEWAY_PAGES = 20;

type JsonRecord = Record<string, unknown>;

export class TTLockGatewayStatusError extends Error {
  readonly errcode: number | null;
  readonly httpStatus: number | null;
  readonly providerRequestCount: number;
  readonly rawPayload: unknown | null;

  constructor(input: {
    message: string;
    errcode?: number | null;
    httpStatus?: number | null;
    providerRequestCount: number;
    rawPayload?: unknown | null;
  }) {
    super(input.message);
    this.name = "TTLockGatewayStatusError";
    this.errcode = input.errcode ?? null;
    this.httpStatus = input.httpStatus ?? null;
    this.providerRequestCount = input.providerRequestCount;
    this.rawPayload = input.rawPayload ?? null;
  }
}

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

function parseErrcode(value: unknown) {
  return finiteNumber(value);
}

async function postForm(input: {
  url: string;
  body: URLSearchParams;
  providerRequestCount: number;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    let response: Response;

    try {
      response = await fetch(input.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: input.body.toString(),
        signal: controller.signal,
      });
    } catch (error) {
      throw new TTLockGatewayStatusError({
        message:
          error instanceof Error && error.name === "AbortError"
            ? "TTLock gateway status request timed out after 20000ms"
            : error instanceof Error
              ? error.message
              : String(error),
        providerRequestCount: input.providerRequestCount,
      });
    }

    const text = await response.text();
    let data: unknown;

    try {
      data = JSON.parse(text);
    } catch {
      throw new TTLockGatewayStatusError({
        message: `TTLock gateway status invalid JSON status=${response.status}`,
        httpStatus: response.status,
        providerRequestCount: input.providerRequestCount,
        rawPayload: text,
      });
    }

    const record = data as JsonRecord;
    const errcode = parseErrcode(record.errcode);

    if (
      !response.ok ||
      (errcode !== null && errcode !== 0)
    ) {
      throw new TTLockGatewayStatusError({
        message: `TTLock errcode=${errcode ?? "UNKNOWN"} errmsg=${
          typeof record.errmsg === "string"
            ? record.errmsg
            : "Unknown TTLock gateway status error"
        }`,
        errcode,
        httpStatus: response.status,
        providerRequestCount: input.providerRequestCount,
        rawPayload: data,
      });
    }

    return data as JsonRecord;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ttlockFetchGatewayStatus(
  ttlockLockId: number
) {
  const accessToken =
    await getDeviceHealthAccessTokenForTtlockLock(
      ttlockLockId
    );

  const base =
    process.env.TTLOCK_API_BASE ??
    "https://api.sciener.com";
  const clientId =
    process.env.TTLOCK_CLIENT_ID ?? "";

  let providerRequestCount = 1;

  const associationRaw = await postForm({
    url: `${base}/v3/gateway/listByLock`,
    body: new URLSearchParams({
      clientId,
      accessToken,
      lockId: String(ttlockLockId),
      date: String(Date.now()),
    }),
    providerRequestCount,
  });

  const associationList = Array.isArray(associationRaw.list)
    ? associationRaw.list
    : [];

  if (associationList.length === 0) {
    return {
      hasGateway: false,
      isOnline: false,
      gatewayId: null as number | null,
      gatewayRssi: null as number | null,
      providerRequestCount,
      providerResponseAt: new Date(),
      raw: {
        association: associationRaw,
        accountGateways: null as unknown[] | null,
      },
    };
  }

  const first = associationList[0] as JsonRecord;
  const gatewayId = finiteNumber(first.gatewayId);
  const gatewayRssi = finiteNumber(first.rssi);

  if (gatewayId === null) {
    throw new TTLockGatewayStatusError({
      message: "TTLock returned a gateway association without gatewayId",
      providerRequestCount,
      rawPayload: associationRaw,
    });
  }

  let pageNo = 1;
  let matchedGateway: JsonRecord | null = null;
  const accountGatewayPages: unknown[] = [];

  while (
    pageNo <= MAX_GATEWAY_PAGES &&
    matchedGateway === null
  ) {
    providerRequestCount += 1;

    const accountRaw = await postForm({
      url: `${base}/v3/gateway/list`,
      body: new URLSearchParams({
        clientId,
        accessToken,
        pageNo: String(pageNo),
        pageSize: String(PAGE_SIZE),
        date: String(Date.now()),
      }),
      providerRequestCount,
    });

    accountGatewayPages.push(accountRaw);

    const list = Array.isArray(accountRaw.list)
      ? accountRaw.list
      : [];

    matchedGateway =
      (list.find((item) => {
        if (!item || typeof item !== "object") {
          return false;
        }
        return finiteNumber(
          (item as JsonRecord).gatewayId
        ) === gatewayId;
      }) as JsonRecord | undefined) ?? null;

    const pages = finiteNumber(accountRaw.pages);
    const total = finiteNumber(accountRaw.total);

    if (matchedGateway) break;
    if (pages !== null && pageNo >= pages) break;
    if (pages === null && list.length < PAGE_SIZE) break;
    if (total !== null && pageNo * PAGE_SIZE >= total) break;

    pageNo += 1;
  }

  if (!matchedGateway) {
    throw new TTLockGatewayStatusError({
      message:
        `TTLock gateway ${gatewayId} is associated with lock ${ttlockLockId} but was not found in the account gateway list`,
      providerRequestCount,
      rawPayload: {
        association: associationRaw,
        accountGateways: accountGatewayPages,
      },
    });
  }

  const isOnlineValue = finiteNumber(
    matchedGateway.isOnline
  );

  if (isOnlineValue !== 0 && isOnlineValue !== 1) {
    throw new TTLockGatewayStatusError({
      message:
        `TTLock gateway ${gatewayId} returned an invalid isOnline value`,
      providerRequestCount,
      rawPayload: matchedGateway,
    });
  }

  return {
    hasGateway: true,
    isOnline: isOnlineValue === 1,
    gatewayId,
    gatewayRssi,
    providerRequestCount,
    providerResponseAt: new Date(),
    raw: {
      association: associationRaw,
      gateway: matchedGateway,
    },
  };
}
