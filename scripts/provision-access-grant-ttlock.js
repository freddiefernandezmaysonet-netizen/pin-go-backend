// scripts/provision-access-grant-ttlock.js
import dotenv from "dotenv";
dotenv.config({ override: true });
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const API_BASE = process.env.TTLOCK_API_BASE || "https://api.sciener.com";
const CLIENT_ID = process.env.TTLOCK_CLIENT_ID;
const CLIENT_SECRET = process.env.TTLOCK_CLIENT_SECRET;

function assertEnv() {
  const required = ["ORG_ID", "TTLOCK_CLIENT_ID", "TTLOCK_CLIENT_SECRET", "ACCESS_GRANT_ID"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Faltan env vars: ${missing.join(", ")}`);
}

async function postForm(url, data) {
  const body = new URLSearchParams(data);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(json)}`);
  if (json?.errcode) throw new Error(`TTLock errcode=${json.errcode} errmsg=${json.errmsg}`);

  return json;
}

async function refreshAccessToken(refreshToken) {
  return postForm(`${API_BASE}/oauth2/token`, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function getValidAccessToken(organizationId) {
  const auth = await prisma.tTLockAuth.findUnique({ where: { organizationId } });
  if (!auth?.accessToken || !auth?.refreshToken) {
    throw new Error("No hay TTLockAuth guardado. Corre primero scripts/ttlock-auth-sync.js");
  }

  const msLeft = auth.expiresAt ? auth.expiresAt.getTime() - Date.now() : 0;
  if (msLeft > 2 * 60 * 1000) return auth.accessToken;

  const token = await refreshAccessToken(auth.refreshToken);

  const accessToken = token.access_token;
  const newRefreshToken = token.refresh_token || auth.refreshToken;
  const expiresIn = Number(token.expires_in || 7200);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await prisma.tTLockAuth.update({
    where: { organizationId },
    data: { accessToken, refreshToken: newRefreshToken, expiresAt },
  });

  console.log("🔁 AccessToken refrescado");
  return accessToken;
}

// Genera un código numérico simple (6-10 dígitos)
function generatePin(len = 8) {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  // evita que empiece con 0 por estética
  if (s[0] === "0") s = "1" + s.slice(1);
  return s;
}

// máscara segura para DB/logs
function maskPin(pin) {
  if (!pin) return null;
  const last4 = pin.slice(-4);
  return `****${last4}`;
}

function toUnixMs(d) {
  return d.getTime();
}

async function main() {
  assertEnv();

  const ORG_ID = process.env.ORG_ID;
  const ACCESS_GRANT_ID = process.env.ACCESS_GRANT_ID;

  // 1) Busca el grant + lock
  const grant = await prisma.accessGrant.findUnique({
    where: { id: ACCESS_GRANT_ID },
    include: { lock: true },
  });

  if (!grant) throw new Error(`No existe AccessGrant: ${ACCESS_GRANT_ID}`);
  if (!grant.lock) throw new Error("AccessGrant no tiene lock asociado (data corrupta).");

  if (grant.method !== "PASSCODE_TIMEBOUND") {
    throw new Error(`Este script solo provisiona PASSCODE_TIMEBOUND. Método actual: ${grant.method}`);
  }

  // Si ya está provisionado, no duplicar
  if (grant.ttlockKeyboardPwdId) {
    console.log("✅ Ya estaba provisionado en TTLock:");
    console.log({ accessGrantId: grant.id, ttlockKeyboardPwdId: grant.ttlockKeyboardPwdId, status: grant.status });
    return;
  }

  const accessToken = await getValidAccessToken(ORG_ID);

  // 2) Genera PIN (NO lo guardamos en texto plano)
  const pinLength = Number(process.env.PIN_LENGTH || 8);
  const pin = generatePin(pinLength);
  const masked = maskPin(pin);

  // 3) Ventana (TTLock usa timestamps en ms en muchos endpoints v3)
  const startDate = toUnixMs(new Date(grant.startsAt));
  const endDate = toUnixMs(new Date(grant.endsAt));

  // 4) Llamada a TTLock: add keyboard password
  // Endpoint típico: /v3/keyboardPwd/add
  // Campos comunes: clientId, accessToken, lockId, keyboardPwd, keyboardPwdName, startDate, endDate, date
  const resp = await postForm(`${API_BASE}/v3/keyboardPwd/add`, {
    clientId: CLIENT_ID,
    accessToken,
    lockId: String(grant.lock.ttlockLockId),
    keyboardPwd: pin,
    keyboardPwdName: `PinGo-${grant.id.slice(-6)}`,
    startDate: String(startDate),
    endDate: String(endDate),
    date: String(Date.now()),
  });

  // Respuesta suele incluir keyboardPwdId (puede variar el nombre)
  const keyboardPwdId =
    resp.keyboardPwdId ?? resp.keyboardPwdid ?? resp.keyboardPwdID ?? resp.id ?? null;

  if (!keyboardPwdId) {
    throw new Error(`TTLock no devolvió keyboardPwdId. Resp: ${JSON.stringify(resp).slice(0, 300)}`);
  }

  // 5) Actualiza DB
  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: {
      status: "ACTIVE",
      ttlockKeyboardPwdId: Number(keyboardPwdId),
      accessCodeMasked: masked,
      ttlockPayload: resp,
      lastError: null,
    },
  });

  console.log("✅ Passcode provisionado en TTLock y AccessGrant ACTIVADO");
  console.log({
    accessGrantId: grant.id,
    ttlockLockId: grant.lock.ttlockLockId,
    ttlockKeyboardPwdId: Number(keyboardPwdId),
    accessCodeMasked: masked,
    window: { startsAt: grant.startsAt, endsAt: grant.endsAt },
  });

  console.log("\n📌 NOTA:");
  console.log("- El PIN real NO se guarda en DB (solo masked).");
  console.log("- Si quieres enviarlo por SMS/WhatsApp, lo hacemos en el siguiente paso (MessageLog/Twilio).");
}

main()
  .catch((e) => {
    console.error("❌ provision-access-grant-ttlock error:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
