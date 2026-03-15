import { getDeviceHealthAccessToken } from "./ttlock.deviceHealth.auth";

export async function ttlockFetchBattery(ttlockLockId: number) {
  const accessToken = await getDeviceHealthAccessToken();

  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

  const body = new URLSearchParams({
    clientId: process.env.TTLOCK_CLIENT_ID ?? "",
    accessToken,
    lockId: String(ttlockLockId),
    date: String(Date.now()),
  });

  const resp = await fetch(`${base}/v3/lock/queryElectricQuantity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await resp.text();

  const data = JSON.parse(text);

  if (!resp.ok || data?.errcode) {
    throw new Error(`TTLock errcode=${data?.errcode} errmsg=${data?.errmsg}`);
  }

  return {
    battery: data.electricQuantity ?? null,
    raw: data,
  };
}
