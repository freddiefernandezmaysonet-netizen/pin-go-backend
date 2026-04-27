// src/ttlock/ttlock.passcode.ts
import { ttlockGetAccessToken } from "./ttlock.service";
import { getDeviceHealthAccessTokenForTtlockLock } from "./ttlock.deviceHealth.auth";

function roundDownToHourMs(ms: number) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

type TTLockResp = { errcode?: number; errmsg?: string } & Record<string, any>;

function toMs(ts: number) {
  // si viene en seconds, lo pasamos a ms
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

async function resolveAccessToken(accessToken?: string, ttlockLockId?: number) {
  if (accessToken) return accessToken;

  if (ttlockLockId) {
    return await getDeviceHealthAccessTokenForTtlockLock(ttlockLockId);
  }

  const token = await ttlockGetAccessToken();
  return typeof token === "string" ? token : token.access_token;
}

async function postForm(url: string, form: Record<string, string | number>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) body.set(k, String(v));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }

  const text = await resp.text();

  let data: TTLockResp;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`TTLock returned non-JSON. First 120: ${text.slice(0, 120)}`);
  }

  if (!resp.ok || data?.errcode) {
    const safe = {
      url,
      status: resp.status,
      errcode: data?.errcode,
      errmsg: data?.errmsg ?? "?",
      lockId: form.lockId,
      keyboardPwdType: form.keyboardPwdType,
      keyboardPwdVersion: form.keyboardPwdVersion,
      startDate: form.startDate,
      endDate: form.endDate,
      date: form.date,
      keys: Object.keys(form).sort(),
    };
    throw new Error(`TTLock error ${JSON.stringify(safe)}`);
  }

  return data;
}

/**
 * ✅ keyboardPwdVersion (REQUIRED para /keyboardPwd/get)
 */
export async function ttlockGetKeyboardPwdVersion(params: {
  lockId: number;
  accessToken?: string;
}) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";
  if (!clientId) throw new Error("Missing TTLOCK_CLIENT_ID");

  const accessToken = await resolveAccessToken(params.accessToken, params.lockId);

  const lockId = Number(params.lockId);
  if (!Number.isFinite(lockId) || lockId <= 0) throw new Error("Invalid lockId");

  return postForm(`${base}/v3/lock/getKeyboardPwdVersion`, {
    clientId,
    accessToken,
    lockId,
    date: Date.now(),
  });
}

/**
 * ✅ OTP / PASSCODE GET
 * keyboardPwdType: 1=one-time, 2=permanent, 3=period
 *
 * Para type=1 (OTP) lo más estable es NO mandar startDate/endDate.
 * Para type=3 (period) sí mandar startDate/endDate (en ms) y start < end.
 */
export async function ttlockGetPasscode(params: {
  lockId: number;
  keyboardPwdType: 1 | 2 | 3;
  name?: string;
  accessToken?: string;

  // solo si keyboardPwdType=3
  startDate?: number; // ms (o seconds; se normaliza)
  endDate?: number; // ms (o seconds; se normaliza)
}) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";
  if (!clientId) throw new Error("Missing TTLOCK_CLIENT_ID");

  const accessToken = await resolveAccessToken(params.accessToken, params.lockId);

  const lockId = Number(params.lockId);
  if (!Number.isFinite(lockId) || lockId <= 0) throw new Error("Invalid lockId");

  // ✅ REQUIRED para /keyboardPwd/get
  const ver = await ttlockGetKeyboardPwdVersion({
    lockId,
    accessToken,
  });

  const keyboardPwdVersion = ver?.keyboardPwdVersion;
  if (!keyboardPwdVersion) throw new Error("Missing keyboardPwdVersion from TTLock");

  const form: Record<string, string | number> = {
    clientId,
    accessToken,
    lockId,
    keyboardPwdType: params.keyboardPwdType,
    keyboardPwdName: params.name ?? "Pin&Go",
    keyboardPwdVersion,
    date: Date.now(),
  };

  // SOLO si es PERIOD (3)
  if (params.keyboardPwdType === 3) {
    if (!params.startDate || !params.endDate) {
      throw new Error("keyboardPwdType=3 requires startDate and endDate");
    }

    let start = toMs(Number(params.startDate));
    let end = toMs(Number(params.endDate));

    // TTLock requiere ventanas por HORA (minutos/segundos en 0)
   
  start = roundDownToHourMs(start);
end = roundDownToHourMs(end);

if (end <= start) {
  end = start + 60 * 60 * 1000;
}

    form.startDate = start;
    form.endDate = end;
  
console.log("[TTLOCK][PASSCODE] period form prepared", {
      lockId,
      keyboardPwdType: params.keyboardPwdType,
      inputStartDate: params.startDate ?? null,
      inputEndDate: params.endDate ?? null,
      normalizedStartDate: start,
      normalizedEndDate: end,
      normalizedStartIso: new Date(start).toISOString(),
      normalizedEndIso: new Date(end).toISOString(),
    });

 }

  // ✅ Para OTP (type=1): este lock requiere startDate/endDate.
  if (params.keyboardPwdType === 1) {
    const start = roundDownToHourMs(Date.now());
    const end = start + 6 * 60 * 60 * 1000; // 6 horas

    form.startDate = start;
    form.endDate = end;
  }

      console.log("[TTLOCK][PASSCODE] sending form", {
      lockId,
      keyboardPwdType: form.keyboardPwdType,
      startDate: form.startDate ?? null,
      endDate: form.endDate ?? null,
      startIso:
        typeof form.startDate === "number"
          ? new Date(form.startDate).toISOString()
          : null,
      endIso:
        typeof form.endDate === "number"
          ? new Date(form.endDate).toISOString()
          : null,
    });  

  try {
    return await postForm(`${base}/v3/keyboardPwd/get`, form);
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    // ✅ Retry: si PERIOD (3) falla con -3, intenta OTP (1) sin fechas.
    
    // ⚠️ IMPORTANTE: NO fallback automático a OTP
if (params.keyboardPwdType === 3 && msg.includes('"errcode":-3')) {
  console.error("[TTLock] PERIOD passcode failed", {
    lockId,
    reason: msg,
    startDate: form.startDate,
    endDate: form.endDate,
  });

  // ❌ NO fallback automático
  // 👉 dejamos que falle para detectar problema real
  throw new Error("TTLock PERIOD passcode failed (errcode -3)");
}
    
     throw e;
  }
}

export async function ttlockChangePasscode(params: {
  lockId: number;
  keyboardPwdId: number;
  startDate: number;
  endDate: number;
}) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";
  if (!clientId) throw new Error("Missing TTLOCK_CLIENT_ID");

  const accessToken = await resolveAccessToken(undefined, params.lockId);

  const lockId = Number(params.lockId);
  if (!Number.isFinite(lockId) || lockId <= 0) throw new Error("Invalid lockId");

  let start = toMs(Number(params.startDate));
  let end = toMs(Number(params.endDate));

  start = roundDownToHourMs(start);
  end = roundDownToHourMs(end);

  if (end <= start) {
    end = start + 60 * 60 * 1000;
  }

  console.log("[TTLOCK][PASSCODE_CHANGE][FORM]", {
    lockId,
    keyboardPwdId: params.keyboardPwdId,
    start,
    end,
    startISO: new Date(start).toISOString(),
    endISO: new Date(end).toISOString(),
  });

  return postForm(`${base}/v3/keyboardPwd/change`, {
    clientId,
    accessToken,
    lockId,
    keyboardPwdId: Number(params.keyboardPwdId),
    startDate: start,
    endDate: end,
    changeType: 2,
    date: Date.now(),
  });
}

export async function ttlockDeletePasscode(params: {
  lockId: number;
  keyboardPwdId: number;
  deleteType?: 1 | 2 | 3; // 1=bluetooth, 2=gateway, 3=nbiot
  accessToken?: string;
}) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";
  if (!clientId) throw new Error("Missing TTLOCK_CLIENT_ID");

  const accessToken = await resolveAccessToken(params.accessToken, params.lockId);

  const lockId = Number(params.lockId);
  if (!Number.isFinite(lockId) || lockId <= 0) throw new Error("Invalid lockId");

  return postFormWithRetry(`${base}/v3/keyboardPwd/delete`, {
    clientId,
    accessToken,
    lockId,
    keyboardPwdId: Number(params.keyboardPwdId),
    deleteType: Number(params.deleteType ?? 2),
    date: Date.now(),
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postFormWithRetry(
  url: string,
  form: Record<string, string | number | undefined>,
  opts?: { retries?: number; baseDelayMs?: number }
) {
  const retries = opts?.retries ?? 5;
  const baseDelayMs = opts?.baseDelayMs ?? 800;

  let lastErr: any = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await postForm(url, form as Record<string, string | number>);
    } catch (e: any) {
      lastErr = e;

      const msg = String(e?.message ?? e);
      const isBusy =
        msg.includes("errcode=-3003") ||
        msg.toLowerCase().includes("gateway is busy");

      if (!isBusy || attempt === retries) throw e;

      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * ✅ CUSTOM PASSCODE ADD (si algún día lo vuelves a usar)
 */
export async function ttlockCreatePasscode(params: {
  lockId: number;
  code: string;
  startDate: number; // ms (o seconds; se normaliza)
  endDate: number; // ms (o seconds; se normaliza)
  addType?: number;
  name?: string;
  accessToken?: string;
}) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";
  if (!clientId) throw new Error("Missing TTLOCK_CLIENT_ID");

  const accessToken = await resolveAccessToken(params.accessToken, params.lockId);

  const lockId = Number(params.lockId);
  if (!Number.isFinite(lockId) || lockId <= 0) throw new Error("Invalid lockId");

  const start = toMs(Number(params.startDate));
  const end = toMs(Number(params.endDate));
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("Invalid start/end");
  }
  if (start >= end) throw new Error("startDate must be < endDate");

  return postForm(`${base}/v3/keyboardPwd/add`, {
    clientId,
    accessToken,
    lockId,
    keyboardPwd: params.code,
    keyboardPwdName: params.name ?? "Pin&Go Custom",
    startDate: start,
    endDate: end,
    addType: Number(params.addType ?? 2),
    date: Date.now(),
  });
}