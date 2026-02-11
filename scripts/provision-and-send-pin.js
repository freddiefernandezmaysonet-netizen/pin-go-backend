// scripts/provision-and-send-pin.js
import dotenv from "dotenv";
dotenv.config({ override: true });
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import twilio from "twilio";

const prisma = new PrismaClient();

// ==============================
// ENV (TTLock + Twilio)
// ==============================
const API_BASE = process.env.TTLOCK_API_BASE || "https://api.sciener.com";
const CLIENT_ID = process.env.TTLOCK_CLIENT_ID;
const CLIENT_SECRET = process.env.TTLOCK_CLIENT_SECRET;

// ==============================
// HELPERS
// ==============================
function assertEnv() {
  const required = [
    "ORG_ID",
    "ACCESS_GRANT_ID",

    "TTLOCK_CLIENT_ID",
    "TTLOCK_CLIENT_SECRET",

    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM",
    "TO_PHONE",
  ];

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

  // TTLock a veces responde HTML cuando hay 404/errores
  const text = await res.text().catch(() => "");
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // si no es JSON (por ejemplo HTML), lo dejamos en text
  }

  if (!res.ok) {
    const preview = text?.slice(0, 300);
    throw new Error(`HTTP ${res.status} ${url}: ${preview}`);
  }

  if (json?.errcode) {
    throw new Error(`TTLock errcode=${json.errcode} errmsg=${json.errmsg}`);
  }

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
    throw new Error("No hay TTLockAuth en DB. Corre primero: node -r dotenv/config scripts/ttlock-auth-sync.js");
  }

  const msLeft = auth.expiresAt ? auth.expiresAt.getTime() - Date.now() : 0;

  // si el token aún tiene más de 2 minutos, úsalo
  if (msLeft > 2 * 60 * 1000) return auth.accessToken;

  // si no, refrescamos
  const token = await refreshAccessToken(auth.refreshToken);
  const accessToken = token.access_token;
  const newRefreshToken = token.refresh_token || auth.refreshToken;
  const expiresIn = Number(token.expires_in || 7200);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await prisma.tTLockAuth.update({
    where: { organizationId },
    data: { accessToken, refreshToken: newRefreshToken, expiresAt },
  });

  console.log("🔁 TTLock accessToken refrescado");
  return accessToken;
}

function generatePin(len = 8) {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  if (s[0] === "0") s = "1" + s.slice(1);
  return s;
}

function maskPin(pin) {
  return `****${pin.slice(-4)}`;
}

function fmtLocal(dt) {
  return new Date(dt).toLocaleString("en-US");
}

function resolveWindow(grant) {
  // Por default usa lo que está en el AccessGrant
  let startsAt = new Date(grant.startsAt);
  let endsAt = new Date(grant.endsAt);

  // Si quieres forzar la vigencia a 6 horas (como TTLock te limita),
  // activa FORCE_6H=1 en .env
  if (process.env.FORCE_6H === "1") {
    startsAt = new Date();
    endsAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
  }

  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new Error("startsAt/endsAt inválidos en AccessGrant.");
  }
  if (endsAt <= startsAt) {
    throw new Error("ENDS_AT debe ser mayor que STARTS_AT (endsAt <= startsAt).");
  }

  return { startsAt, endsAt };
}

// ==============================
// MAIN
// ==============================
async function main() {
  assertEnv();

  const ORG_ID = process.env.ORG_ID;
  const ACCESS_GRANT_ID = process.env.ACCESS_GRANT_ID;

  // 1) Cargar AccessGrant + Lock
  const grant = await prisma.accessGrant.findUnique({
    where: { id: ACCESS_GRANT_ID },
    include: { lock: true },
  });

  if (!grant) throw new Error(`No existe AccessGrant: ${ACCESS_GRANT_ID}`);
  if (!grant.lock) throw new Error("AccessGrant no tiene lock asociado.");
  if (grant.method !== "PASSCODE_TIMEBOUND") {
    throw new Error(`Este script solo maneja PASSCODE_TIMEBOUND. Método actual: ${grant.method}`);
  }

  // Si ya fue provisionado, no podemos reenviar porque NO guardamos el PIN real
  if (grant.ttlockKeyboardPwdId) {
    throw new Error(
      `Este AccessGrant ya fue provisionado (ttlockKeyboardPwdId=${grant.ttlockKeyboardPwdId}). ` +
        `No guardamos el PIN real en DB, por eso NO se puede reenviar. ` +
        `Solución: revocar y crear uno nuevo.`
    );
  }

  if (!grant.lock.ttlockLockId) {
    throw new Error("El Lock en DB no tiene ttlockLockId. Corre sync-locks o revisa el registro.");
  }

  console.log("ℹ️ Usando AccessGrant:", {
    id: grant.id,
    lockId: grant.lockId,
    ttlockLockId: grant.lock.ttlockLockId,
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
  });

  // 2) Token válido TTLock (desde DB + refresh si hace falta)
  const accessToken = await getValidAccessToken(ORG_ID);

  // 3) Crear PIN (solo memoria; NO lo guardamos en DB)
  const pinLength = Number(process.env.PIN_LENGTH || 8);
  const pin = generatePin(pinLength);
  const masked = maskPin(pin);

  // 4) Ventana de tiempo (ms)
  const { startsAt, endsAt } = resolveWindow(grant);
  const startDateMs = startsAt.getTime();
  const endDateMs = endsAt.getTime();

  // 5) Crear passcode en TTLock
  const resp = await postForm(`${API_BASE}/v3/keyboardPwd/add`, {
    clientId: CLIENT_ID,
    accessToken,
    lockId: String(grant.lock.ttlockLockId),
    keyboardPwd: pin,
    keyboardPwdName: `PinGo-${grant.id.slice(-6)}`,
    startDate: String(startDateMs),
    endDate: String(endDateMs),
    date: String(Date.now()),
  });

  const keyboardPwdId =
    resp.keyboardPwdId ?? resp.keyboardPwdid ?? resp.keyboardPwdID ?? resp.id ?? null;

  if (!keyboardPwdId) {
    throw new Error(`TTLock no devolvió keyboardPwdId. Resp: ${JSON.stringify(resp).slice(0, 400)}`);
  }

  // 6) Guardar en DB
  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: {
      status: "ACTIVE",
      ttlockKeyboardPwdId: Number(keyboardPwdId),
      accessCodeMasked: masked,
      ttlockPayload: resp,
      lastError: null,
      // opcional: guardar ventana real si FORCE_6H=1
      startsAt,
      endsAt,
    },
  });

  // 7) Enviar SMS (Twilio)
  const to = process.env.TO_PHONE;       // +1787... o whatsapp:+1787...
  const from = process.env.TWILIO_FROM; // +1...  o whatsapp:+1...

  const hours = Math.max(1, Math.round((endDateMs - startDateMs) / (1000 * 60 * 60)));
  const lockName = grant.lock.ttlockLockName || "la cerradura";

  const body =
    `Pin&Go acceso de entrada (válido ~${hours}h)\n` +
    `🔐 ${lockName}\n` +
    `PIN: ${pin}\n` +
    `Válido desde: ${fmtLocal(startsAt)}\n` +
    `Hasta: ${fmtLocal(endsAt)}\n` +
    `Luego entrarás con tu tarjeta NFC.\n`;

  const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  let msg;
  try {
    msg = await tw.messages.create({ to, from, body });
  } catch (e) {
    // si Twilio falla, dejamos el AccessGrant ACTIVE porque el PIN ya existe en TTLock
    // pero guardamos el error para que puedas reenviar creando OTRO AccessGrant
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: { lastError: `Twilio: ${e?.message || String(e)}` },
    });
    throw new Error(`Twilio falló enviando SMS: ${e?.message || e}`);
  }

  // 8) Log en DB (MessageLog)
  await prisma.messageLog.create({
    data: {
      channel: to.startsWith("whatsapp:") ? "whatsapp" : "sms",
      to,
      from,
      body,
      provider: "twilio",
      providerMessageId: msg.sid,
      status: msg.status,
      accessGrantId: grant.id,
    },
  });

  console.log("✅ PIN creado en TTLock y mensaje enviado");
  console.log({
    accessGrantId: grant.id,
    ttlockKeyboardPwdId: Number(keyboardPwdId),
    to,
    providerMessageId: msg.sid,
    status: msg.status,
  });
}

main()
  .catch((e) => {
    console.error("❌ provision-and-send-pin error:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
