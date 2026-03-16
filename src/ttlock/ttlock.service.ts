// src/ttlock/ttlock.service.ts
import "dotenv/config";
import crypto from "crypto";

export type TTLockTokenResponse = {
  access_token: string;
  refresh_token: string;
  uid?: number;
  expires_in: number;
  scope?: string;
};

function md5Lower32(input: string) {
  return crypto.createHash("md5").update(input, "utf8").digest("hex");
}

async function postForm<T = any>(url: string, body: Record<string, any>): Promise<T> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    form.set(k, String(v));
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data = (await resp.json()) as any;

  if (!resp.ok) {
    throw new Error(`TTLock HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }

  return data as T;
}

export async function ttlockGetAccessTokenFromCredentials(params: {
  username: string;
  passwordPlain: string;
}): Promise<TTLockTokenResponse> {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const client_id = process.env.TTLOCK_CLIENT_ID;
  const client_secret = process.env.TTLOCK_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    throw new Error("Missing TTLOCK_CLIENT_ID / TTLOCK_CLIENT_SECRET");
  }

  const resp = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      username: params.username,
      password: md5Lower32(params.passwordPlain),
    }).toString(),
  });

  const data = (await resp.json()) as any;

  if (!resp.ok) {
    throw new Error(`TTLock HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }

  if (!data?.access_token) {
    throw new Error(`TTLock token missing access_token: ${JSON.stringify(data)}`);
  }

  return data as TTLockTokenResponse;
}

export async function ttlockRefreshAccessToken(params: {
  refreshToken: string;
}): Promise<TTLockTokenResponse> {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const client_id = process.env.TTLOCK_CLIENT_ID;
  const client_secret = process.env.TTLOCK_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    throw new Error("Missing TTLOCK_CLIENT_ID / TTLOCK_CLIENT_SECRET");
  }

  const data = await postForm<TTLockTokenResponse>(`${base}/oauth2/token`, {
    client_id,
    client_secret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });

  if (!(data as any)?.access_token) {
    throw new Error(`TTLock refresh missing access_token: ${JSON.stringify(data)}`);
  }

  return data;
}

// fallback solo para development si todavía quieres usarlo
export async function ttlockGetAccessToken(): Promise<TTLockTokenResponse> {
  const username = process.env.TTLOCK_USERNAME;
  const passwordPlain = process.env.TTLOCK_PASSWORD_PLAIN;

  if (!username || !passwordPlain) {
    throw new Error(
      "Missing TTLOCK_USERNAME / TTLOCK_PASSWORD_PLAIN for dev fallback"
    );
  }

  return ttlockGetAccessTokenFromCredentials({
    username,
    passwordPlain,
  });
}

/**
 * ✅ Borra (revoca) un keyboardPwd existente en TTLock.
 * Por ahora sigue usando fallback env.
 */
export async function ttlockDeleteKeyboardPwd(params: {
  lockId: number;
  keyboardPwdId: number;
}) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID;
  if (!clientId) throw new Error("Missing TTLOCK_CLIENT_ID");

  const token = await ttlockGetAccessToken();

  return postForm(`${base}/v3/keyboardPwd/delete`, {
    clientId,
    accessToken: token.access_token,
    lockId: params.lockId,
    keyboardPwdId: params.keyboardPwdId,
    date: Date.now(),
  });
}