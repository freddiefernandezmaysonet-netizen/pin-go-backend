import { tuyaRequest } from "./tuya.http";
import type {
  TuyaProjectTokenResponse,
  TuyaProjectTokenResult,
} from "./tuya.types";

type TokenCache = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
} | null;

let cache: TokenCache = null;

function isCacheValid() {
  if (!cache) return false;
  return Date.now() < cache.expiresAtMs - 60_000;
}

export async function getTuyaToken(
  forceRefresh = false
): Promise<TuyaProjectTokenResult> {
  if (!forceRefresh && isCacheValid() && cache) {
    return {
      access_token: cache.accessToken,
      refresh_token: cache.refreshToken,
      expire_time: Math.max(
        1,
        Math.floor((cache.expiresAtMs - Date.now()) / 1000)
      ),
    };
  }

  const resp: TuyaProjectTokenResponse =
    await tuyaRequest<TuyaProjectTokenResult>({
      method: "GET",
      path: "/v1.0/token",
      query: { grant_type: 1 },
    });

  if (!resp.success || !resp.result?.access_token) {
    throw new Error(`TUYA_TOKEN_FAILED: ${resp.msg ?? resp.code ?? "unknown"}`);
  }

  const result = resp.result;

  cache = {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAtMs: Date.now() + result.expire_time * 1000,
  };

  console.log("[tuya] project token ok", {
    hasAccessToken: Boolean(result.access_token),
    expireTime: result.expire_time,
  });

  return result;
}

export async function getValidTuyaAccessToken() {
  const token = await getTuyaToken(false);

  if (!token.access_token) {
    throw new Error("TUYA_ACCESS_TOKEN_MISSING");
  }

  return token.access_token;
}

export function clearTuyaTokenCache() {
  cache = null;
}