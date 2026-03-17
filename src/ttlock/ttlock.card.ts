// src/ttlock/ttlock.card.ts
import { ttlockGetAccessToken } from "./ttlock.service";

async function resolveAccessToken(accessToken?: string) {
  if (accessToken) return accessToken;
  const token = await ttlockGetAccessToken();
  return token.access_token;
}

async function postForm(url: string, form: Record<string, string | number | undefined>) {
  const body = new URLSearchParams();
  Object.entries(form).forEach(([k, v]) => {
    if (v !== undefined && v !== null) body.set(k, String(v));
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await resp.text();

  if (text.trim().startsWith("<")) {
    throw new Error("TTLock returned HTML instead of JSON");
  }

  const data = JSON.parse(text);

  if (!resp.ok || data?.errcode) {
    throw new Error(`TTLock errcode=${data?.errcode} errmsg=${data?.errmsg}`);
  }

  return data;
}

function ttlockBase() {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";
  if (!clientId) throw new Error("Missing TTLOCK_CLIENT_ID");
  return { base, clientId };
}

export async function ttlockListCards(params: {
  lockId: number;
  pageNo: number;
  pageSize: number;
  accessToken?: string;
}) {
  const { base, clientId } = ttlockBase();
  const accessToken = await resolveAccessToken(params.accessToken);

  return postForm(`${base}/v3/identityCard/list`, {
    clientId,
    accessToken,
    lockId: params.lockId,
    pageNo: params.pageNo,
    pageSize: params.pageSize,
    date: Date.now(),
  });
}

export async function ttlockChangeCardPeriod(params: {
  lockId: number;
  cardId: number;
  startDate: number;
  endDate: number;
  changeType?: 1 | 2 | 3; // 2 = gateway
  accessToken?: string;
}) {
  const { base, clientId } = ttlockBase();
  const accessToken = await resolveAccessToken(params.accessToken);

  return postForm(`${base}/v3/identityCard/changePeriod`, {
    clientId,
    accessToken,
    lockId: params.lockId,
    cardId: params.cardId,
    startDate: params.startDate,
    endDate: params.endDate,
    changeType: params.changeType ?? 2,
    date: Date.now(),
  });
}

export async function ttlockDeleteCard(params: {
  lockId: number;
  cardId: number;
  deleteType?: 1 | 2 | 3; // 2 = gateway
  accessToken?: string;
}) {
  const { base, clientId } = ttlockBase();
  const accessToken = await resolveAccessToken(params.accessToken);

  return postForm(`${base}/v3/identityCard/delete`, {
    clientId,
    accessToken,
    lockId: params.lockId,
    cardId: params.cardId,
    deleteType: params.deleteType ?? 2,
    date: Date.now(),
  });
}