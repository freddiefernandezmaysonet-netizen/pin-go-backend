import { ttlockGetAccessToken } from "./ttlock.service";

type TtlockDeviceHealthResult = {
  battery?: number | null;
  gatewayConnected?: boolean | null;
  isOnline?: boolean | null;
  raw: unknown;
};

export async function ttlockFetchDeviceHealth(
  ttlockLockId: number
): Promise<TtlockDeviceHealthResult> {
  const accessToken = await ttlockGetAccessToken();

  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

  const body = new URLSearchParams({
    clientId: process.env.TTLOCK_CLIENT_ID ?? "",
    accessToken,
    lockId: String(ttlockLockId),
    date: String(Date.now()),
  });

  const resp = await fetch(`${base}/v3/lock/queryOpenState`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await resp.text();

  if (text.trim().startsWith("<")) {
    throw new Error("TTLock returned HTML instead of JSON");
  }

  const data = JSON.parse(text);

  if (!resp.ok || data?.errcode) {
    throw new Error(
      `TTLock errcode=${data?.errcode} errmsg=${data?.errmsg}`
    );
  }

  return {
    battery:
      typeof data?.electricQuantity === "number"
        ? data.electricQuantity
        : null,
    gatewayConnected:
      typeof data?.hasGateway === "boolean"
        ? data.hasGateway
        : null,
    isOnline: null,
    raw: data,
  };
}