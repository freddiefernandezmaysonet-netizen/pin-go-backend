// scripts/test-ttlock-lock-access.js
import dotenv from "dotenv";
dotenv.config({ override: true });
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const API_BASE = process.env.TTLOCK_API_BASE || "https://api.sciener.com";
const CLIENT_ID = process.env.TTLOCK_CLIENT_ID;

async function postForm(url, data) {
  const body = new URLSearchParams(data);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}\n${text}`);
  }

  if (json?.errcode) {
    throw new Error(`TTLock errcode=${json.errcode} errmsg=${json.errmsg}`);
  }

  return json;
}

async function main() {
  const ORG_ID = process.env.ORG_ID;
  const ACCESS_GRANT_ID = process.env.ACCESS_GRANT_ID;

  if (!ORG_ID) throw new Error("Falta ORG_ID");
  if (!ACCESS_GRANT_ID) throw new Error("Falta ACCESS_GRANT_ID");

  const auth = await prisma.tTLockAuth.findUnique({
    where: { organizationId: ORG_ID },
  });

  if (!auth?.accessToken) {
    throw new Error("No hay TTLockAuth. Corre ttlock-auth-sync.js");
  }

  const grant = await prisma.accessGrant.findUnique({
    where: { id: ACCESS_GRANT_ID },
    include: { lock: true },
  });

  if (!grant?.lock?.ttlockLockId) {
    throw new Error("No encontré el lock del AccessGrant");
  }

  console.log("🔎 Probando acceso a lock...");
  console.log("LockId:", grant.lock.ttlockLockId);

  // ✅ endpoint REAL
  const resp = await postForm(`${API_BASE}/v3/lock/detail`, {
    clientId: CLIENT_ID,
    accessToken: auth.accessToken,
    lockId: String(grant.lock.ttlockLockId),
    date: String(Date.now()),
  });

  console.log("✅ El token TIENE acceso a este lock");
  console.log({
    lockId: resp.lockId,
    lockName: resp.lockName || resp.lockAlias,
  });
}

main()
  .catch((e) => {
    console.error("❌ test-ttlock-lock-access error:");
    console.error(e.message);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
