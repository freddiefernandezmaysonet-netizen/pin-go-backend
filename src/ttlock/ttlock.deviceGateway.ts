import {
  getDeviceHealthAccessTokenForTtlockLock,
} from "./ttlock.deviceHealth.auth";

const TTLOCK_REQUEST_TIMEOUT_MS =
  20_000;

export type TTLockGatewayErrorDetails = {
  domain: "GATEWAY";
  message: string;
  errcode: number | null;
  httpStatus: number | null;
  rawPayload: unknown | null;
  providerResponded: boolean;
  providerResponseAt: Date | null;
  timedOut: boolean;
};

export class TTLockGatewayError extends Error {
  readonly details: TTLockGatewayErrorDetails;

  constructor(
    details: TTLockGatewayErrorDetails
  ) {
    super(details.message);

    this.name = "TTLockGatewayError";
    this.details = details;
  }
}

function parseErrcode(
  value: unknown
): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : null;
  }

  if (
    typeof value === "string" &&
    value.trim() !== ""
  ) {
    const parsed =
      Number(value);

    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  return null;
}

function parseFiniteNumber(
  value: unknown
): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : null;
  }

  if (
    typeof value === "string" &&
    value.trim() !== ""
  ) {
    const parsed =
      Number(value);

    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  return null;
}

function extractGatewayRssi(
  gateway: unknown
): number | null {
  if (
    !gateway ||
    typeof gateway !== "object"
  ) {
    return null;
  }

  const record =
    gateway as Record<string, unknown>;

  /*
   * TTLock payloads may vary by gateway model or
   * provider API version. Only normalize an explicit
   * signal field when one is present.
   */
  const candidates = [
    record.rssi,
    record.RSSI,
    record.signal,
    record.signalStrength,
  ];

  for (const candidate of candidates) {
    const parsed =
      parseFiniteNumber(candidate);

    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

export async function ttlockFetchGateway(
  ttlockLockId: number
) {
  const accessToken =
    await getDeviceHealthAccessTokenForTtlockLock(
      ttlockLockId
    );

  const base =
    process.env.TTLOCK_API_BASE ??
    "https://api.sciener.com";

  const body =
    new URLSearchParams({
      clientId:
        process.env.TTLOCK_CLIENT_ID ?? "",
      accessToken,
      lockId: String(ttlockLockId),
      date: String(Date.now()),
    });

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      TTLOCK_REQUEST_TIMEOUT_MS
    );

  try {
    let resp: Response;

    try {
      resp =
        await fetch(
          `${base}/v3/gateway/listByLock`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded",
            },
            body: body.toString(),
            signal: controller.signal,
          }
        );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        throw new TTLockGatewayError({
          domain: "GATEWAY",
          message:
            "TTLock gateway request timed out after 20000ms",
          errcode: null,
          httpStatus: null,
          rawPayload: null,
          providerResponded: false,
          providerResponseAt: null,
          timedOut: true,
        });
      }

      throw new TTLockGatewayError({
        domain: "GATEWAY",
        message:
          error instanceof Error
            ? error.message
            : String(error),
        errcode: null,
        httpStatus: null,
        rawPayload: null,
        providerResponded: false,
        providerResponseAt: null,
        timedOut: false,
      });
    }

    const providerResponseAt =
      new Date();

    const text =
      await resp.text();

    let data: unknown;

    try {
      data = JSON.parse(text);
    } catch {
      throw new TTLockGatewayError({
        domain: "GATEWAY",
        message:
          `TTLock gateway invalid JSON status=${resp.status}`,
        errcode: null,
        httpStatus: resp.status,
        rawPayload: text,
        providerResponded: true,
        providerResponseAt,
        timedOut: false,
      });
    }

    const payload =
      data as {
        errcode?: unknown;
        errmsg?: unknown;
        list?: unknown;
      };

    const errcode =
      parseErrcode(
        payload?.errcode
      );

    if (
      !resp.ok ||
      (
        errcode !== null &&
        errcode !== 0
      )
    ) {
      throw new TTLockGatewayError({
        domain: "GATEWAY",
        message:
          `TTLock errcode=${errcode ?? "UNKNOWN"} errmsg=${
            typeof payload?.errmsg ===
            "string"
              ? payload.errmsg
              : "Unknown TTLock gateway error"
          }`,
        errcode,
        httpStatus: resp.status,
        rawPayload: data,
        providerResponded: true,
        providerResponseAt,
        timedOut: false,
      });
    }

    const list =
      Array.isArray(payload?.list)
        ? payload.list
        : [];

    const firstGateway =
      list.length > 0
        ? list[0]
        : null;

    return {
      hasGateway:
        list.length > 0,
      gatewayRssi:
        extractGatewayRssi(
          firstGateway
        ),
      raw: data,
      providerResponseAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}