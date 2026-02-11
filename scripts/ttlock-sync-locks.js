// scripts/ttlock-sync-locks.js
import dotenv from "dotenv";
dotenv.config({ override: true });
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ==============================
// ENV
// ==============================
const API_BASE = process.env.TTLOCK_API_BASE || "https://api.sciener.com";
const CLIENT_ID = process.env.TTLOCK_CLIENT_ID;
const CLIENT_SECRET = process.env.TTLOCK_CLIENT_SECRET;

function assertEnv() {
  const required = [
    "TTLOCK_CLIENT_ID",
    "TTLOCK_CLIENT_SECRET",
    "TTLOCK_API_BASE",
    "ORG_ID",
    "PROPERTY_ID",
  ];

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Faltan env vars: ${missing.join(", ")}`);
  }
}

async function postForm(url, data) {
  const body = new URLSearchParams(data);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(json)}`);
  }

  if (json?.errcode) {
    throw new Error(`TTLock errcode=${json.errcode} errmsg=${json.errmsg}`);
  }

  return json;
}

// ==============================
// TOKEN (refresh si hace falta)
// ==============================
async function refreshAccessToken(refreshToken) {
  return postForm(`${API_BASE}/oauth2/token`, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function getValidAccessToken(organizationId) {
  const auth = await prisma.tTLockAuth.findUnique({
    where: { organizationId },
  });

  if (!auth?.accessToken || !auth?.refreshToken) {
    throw new Error("No hay TTLockAuth guardado. Corre primero scripts/ttlock-auth-sync.js");
  }

  // Si expira en <= 2 minutos, refresca
  const msLeft = auth.expiresAt ? auth.expiresAt.getTime() - Date.now() : 0;

  if (msLeft > 2 * 60 * 1000) {
    return auth.accessToken;
  }

  const token = await refreshAccessToken(auth.refreshToken);

  const accessToken = token.access_token;
  const newRefreshToken = token.refresh_token || auth.refreshToken;
  const expiresIn = Number(token.expires_in || 7200);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await prisma.tTLockAuth.update({
    where: { organizationId },
    data: {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
    },
  });

  console.log("🔁 AccessToken refrescado");
  return accessToken;
}

// ==============================
// TTLOCK: LIST LOCKS
// ==============================
async function listLocks(accessToken, pageNo, pageSize) {
  // v3 lock list (Sciener/TTLock)
  return postForm(`${API_BASE}/v3/lock/list`, {
    clientId: CLIENT_ID,
    accessToken,
    pageNo: String(pageNo),
    pageSize: String(pageSize),
    date: String(Date.now()),
  });
}

// ==============================
// MAIN
// ==============================
async function main() {
  assertEnv();

  const ORGANIZATION_ID = process.env.ORG_ID;
  const PROPERTY_ID = process.env.PROPERTY_ID;

  // Validaciones DB (para evitar upsert con propertyId inválido)
  const prop = await prisma.property.findUnique({ where: { id: PROPERTY_ID } });
  if (!prop) {
    throw new Error(`PROPERTY_ID no existe en DB: ${PROPERTY_ID}`);
  }

  const accessToken = await getValidAccessToken(ORGANIZATION_ID);

  const pageSize = 100;
  let pageNo = 1;
  let totalUpserts = 0;

  // Para marcar activos los que vienen de TTLock
  const seenTtlockLockIds = new Set();

  while (true) {
    const resp = await listLocks(accessToken, pageNo, pageSize);

    const items = resp.list ?? resp.locks ?? [];
    if (!Array.isArray(items) || items.length === 0) break;

    for (const l of items) {
      const ttlockLockId = Number(l.lockId);
      if (!Number.isFinite(ttlockLockId)) continue;

      seenTtlockLockIds.add(ttlockLockId);

      const ttlockLockName = l.lockName ?? null;
      // lockAlias suele venir como “alias”/“lockAlias” dependiendo la respuesta
      const locationLabel = l.lockAlias ?? l.alias ?? null;

      await prisma.lock.upsert({
        where: { ttlockLockId },
        update: {
          ttlockLockName,
          locationLabel,
          isActive: true,
          // no reasignamos propertyId automáticamente para no romper tu mapping
        },
        create: {
          propertyId: PROPERTY_ID,
          ttlockLockId,
          ttlockLockName,
          locationLabel,
          isActive: true,
        },
      });

      totalUpserts++;
    }

    if (items.length < pageSize) break;
    pageNo++;
  }

  // Opcional: marcar como inactivos los locks que ya existen en esa property pero no vinieron en la lista
  // (esto es útil si borraste una cerradura del cloud o cambió la cuenta)
  const existingLocks = await prisma.lock.findMany({
    where: { propertyId: PROPERTY_ID },
    select: { id: true, ttlockLockId: true, isActive: true },
  });

  let deactivated = 0;
  for (const lk of existingLocks) {
    if (!seenTtlockLockIds.has(lk.ttlockLockId) && lk.isActive) {
      await prisma.lock.update({
        where: { id: lk.id },
        data: { isActive: false },
      });
      deactivated++;
    }
  }

  console.log("✅ Sync terminado");
  console.log({
    propertyId: PROPERTY_ID,
    upserted: totalUpserts,
    deactivated,
    pagesRead: pageNo,
  });
}

main()
  .catch((err) => {
    console.error("❌ ttlock-sync-locks error:");
    console.error(err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
