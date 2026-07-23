import {
  getDeviceHealthAccessTokenForTtlockLock,
} from "./ttlock.deviceHealth.auth";

const TTLOCK_REQUEST_TIMEOUT_MS =
  20_000;

function normalizeError(error: unknown) {
  if (
    error instanceof Error &&
    error.name === "AbortError"
  ) {
    return new Error(
      "TTLock gateway request timed out after 20000ms"
    );
  }

  return error;
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
    const resp =
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

    const text =
      await resp.text();

    let data: any;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `TTLock gateway invalid JSON status=${resp.status}`
      );
    }

    if (
      !resp.ok ||
      data?.errcode
    ) {
      throw new Error(
        `TTLock errcode=${data?.errcode ?? "UNKNOWN"} errmsg=${data?.errmsg ?? "Unknown TTLock gateway error"}`
      );
    }

    const list =
      Array.isArray(data?.list)
        ? data.list
        : [];

    return {
      hasGateway:
        list.length > 0,
      raw: data,
    };
  } catch (error) {
    throw normalizeError(error);
  } finally {
    clearTimeout(timeout);
  }
}