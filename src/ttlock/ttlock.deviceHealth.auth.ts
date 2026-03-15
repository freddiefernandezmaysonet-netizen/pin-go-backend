import crypto from "crypto";

type TokenCache = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null;

let cache: TokenCache = null;

const BASE = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

function md5(text: string) {
  return crypto.createHash("md5").update(text).digest("hex");
}

async function requestNewToken() {
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";
  const clientSecret = process.env.TTLOCK_CLIENT_SECRET ?? "";
  const username = process.env.TTLOCK_USERNAME ?? "";
  const passwordPlain = process.env.TTLOCK_PASSWORD_PLAIN ?? "";

  const passwordMd5 = md5(passwordPlain);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password: passwordMd5,
    grant_type: "password",
  });

  const resp = await fetch(`${BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await resp.json();

  if (!resp.ok || !data.access_token) {
    throw new Error(`TTLock auth failed: ${JSON.stringify(data)}`);
  }

  cache = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 0) * 1000,
  };

  return cache.accessToken;
}

async function refreshAccessToken() {
  if (!cache?.refreshToken) {
    return requestNewToken();
  }

  const body = new URLSearchParams({
    client_id: process.env.TTLOCK_CLIENT_ID ?? "",
    client_secret: process.env.TTLOCK_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
    refresh_token: cache.refreshToken,
  });

  const resp = await fetch(`${BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await resp.json();

  if (!resp.ok || !data.access_token) {
    return requestNewToken();
  }

  cache = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 0) * 1000,
  };

  return cache.accessToken;
}

export async function getDeviceHealthAccessToken() {
  if (!cache) {
    return requestNewToken();
  }

  if (Date.now() > cache.expiresAt - 60000) {
    return refreshAccessToken();
  }

  return cache.accessToken;
}
