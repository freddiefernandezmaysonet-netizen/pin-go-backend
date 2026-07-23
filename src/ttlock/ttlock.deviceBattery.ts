import {
  getDeviceHealthAccessTokenForTtlockLock,
} from "./ttlock.deviceHealth.auth";

const TTLOCK_REQUEST_TIMEOUT_MS =
  20_000;

export type TTLockBatteryErrorDetails = {
  domain: "BATTERY";
  message: string;
  errcode: number | null;
  httpStatus: number | null;
  rawPayload: unknown | null;
  providerResponded: boolean;
  providerResponseAt: Date | null;
  timedOut: boolean;
};

export class TTLockBatteryError extends Error {
  readonly details: TTLockBatteryErrorDetails;

  constructor(
    details: TTLockBatteryErrorDetails
  ) {
    super(details.message);

    this.name = "TTLockBatteryError";
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

export async function ttlockFetchBattery(
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
          `${base}/v3/lock/queryElectricQuantity`,
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
        throw new TTLockBatteryError({
          domain: "BATTERY",
          message:
            "TTLock battery request timed out after 20000ms",
          errcode: null,
          httpStatus: null,
          rawPayload: null,
          providerResponded: false,
          providerResponseAt: null,
          timedOut: true,
        });
      }

      throw new TTLockBatteryError({
        domain: "BATTERY",
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
      throw new TTLockBatteryError({
        domain: "BATTERY",
        message:
          `TTLock battery invalid JSON status=${resp.status}`,
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
        electricQuantity?: unknown;
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
      throw new TTLockBatteryError({
        domain: "BATTERY",
        message:
          `TTLock errcode=${errcode ?? "UNKNOWN"} errmsg=${
            typeof payload?.errmsg ===
            "string"
              ? payload.errmsg
              : "Unknown TTLock battery error"
          }`,
        errcode,
        httpStatus: resp.status,
        rawPayload: data,
        providerResponded: true,
        providerResponseAt,
        timedOut: false,
      });
    }

    const battery =
      typeof payload
        ?.electricQuantity ===
      "number"
        ? payload.electricQuantity
        : typeof payload
              ?.electricQuantity ===
            "string"
          ? Number(
              payload.electricQuantity
            )
          : null;

    return {
      battery:
        battery !== null &&
        Number.isFinite(battery)
          ? battery
          : null,
      raw: data,
      providerResponseAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}
