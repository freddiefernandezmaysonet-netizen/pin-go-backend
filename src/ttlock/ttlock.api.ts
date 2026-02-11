// src/ttlock/ttlock.api.ts
import { ttlockGetAccessToken } from "./ttlock.service";

type TTLockListLocksResponse = {
  list?: any[];
  pageNo?: number;
  pageSize?: number;
  total?: number;
  errcode?: number;
  errmsg?: string;
};

async function ttlockGetJson(url: string) {
  const resp = await fetch(url, { method: "GET" });

  const text = await resp.text();

  // A veces cuando falla devuelve HTML -> "<html..."
  if (text.trim().startsWith("<")) {
    throw new Error(`TTLock returned non-JSON (HTML). Check TTLOCK_API_BASE. First 120 chars: ${text.slice(0, 120)}`);
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`TTLock returned invalid JSON. First 120 chars: ${text.slice(0, 120)}`);
  }

  if (!resp.ok) {
    throw new Error(`TTLock HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }

  if (data?.errcode) {
    throw new Error(`TTLock errcode=${data.errcode} errmsg=${data.errmsg ?? "unknown"}`);
  }

  return data;
}

/**
 * Lista cerraduras del usuario TTLock (tu cuenta).
 * Nota: Endpoint puede variar según API base; este es el de TTLock Open Platform típico.
 */

export async function ttlockListLocks(
  pageNo = 1,
  pageSize = 20,
  accessTokenOverride?: string
) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

  const accessToken =
    accessTokenOverride ?? (await ttlockGetAccessToken()).access_token;

  const url =
    `${base}/v3/lock/list` +
    `?clientId=${encodeURIComponent(process.env.TTLOCK_CLIENT_ID ?? "")}` +
    `&accessToken=${encodeURIComponent(accessToken)}` +
    `&pageNo=${pageNo}` +
    `&pageSize=${pageSize}` +
    `&date=${Date.now()}`;

  const data = (await ttlockGetJson(url)) as TTLockListLocksResponse;

  return {
    list: data.list ?? [],
    pageNo: data.pageNo ?? pageNo,
    pageSize: data.pageSize ?? pageSize,
    total: data.total ?? (data.list?.length ?? 0),
  };
}

export async function ttlockListLocksWithAccessToken(
  accessToken: string,
  pageNo = 1,
  pageSize = 100
) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

  const url =
    `${base}/v3/lock/list` +
    `?clientId=${encodeURIComponent(process.env.TTLOCK_CLIENT_ID ?? "")}` +
    `&accessToken=${encodeURIComponent(accessToken)}` +
    `&pageNo=${pageNo}` +
    `&pageSize=${pageSize}` +
    `&date=${Date.now()}`;

  const data = await ttlockGetJson(url);

  return {
    list: data.list ?? [],
    pageNo: data.pageNo ?? pageNo,
    pageSize: data.pageSize ?? pageSize,
    total: data.total ?? (data.list?.length ?? 0),
  };
}

// ---------------------
// POST helpers (global)
// ---------------------

async function ttlockPostJson(url: string, body: Record<string, any>) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(
      Object.entries(body).reduce((acc, [k, v]) => {
        if (v === undefined || v === null) return acc;
        acc[k] = String(v);
        return acc;
      }, {} as Record<string, string>)
    ).toString(),
  });

  const text = await resp.text();

  if (text.trim().startsWith("<")) {
    throw new Error(
      `TTLock returned non-JSON (HTML). Check TTLOCK_API_BASE. First 120 chars: ${text.slice(
        0,
        120
      )}`
    );
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`TTLock returned invalid JSON. First 120 chars: ${text.slice(0, 120)}`);
  }

  if (!resp.ok) {
    throw new Error(`TTLock HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }

  if (data?.errcode) {
    throw new Error(`TTLock errcode=${data.errcode} errmsg=${data.errmsg ?? "unknown"}`);
  }

  return data;
}

export async function ttlockPost(
  path: string,
  params: Record<string, any>,
  accessTokenOverride?: string
) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const accessToken =
    accessTokenOverride ?? (await ttlockGetAccessToken()).access_token;

  const url = `${base}${path}`;

  return ttlockPostJson(url, {
    clientId: process.env.TTLOCK_CLIENT_ID ?? "",
    accessToken,
    ...params,
    date: Date.now(),
  });
}
