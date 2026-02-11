// scripts/ttlock-auth-sync.js
import dotenv from "dotenv";
dotenv.config({ override: true });
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ==============================
// ENV
// ==============================
const API_BASE = process.env.TTLOCK_API_BASE || "https://api.sciener.com";
const CLIENT_ID = process.env.TTLOCK_CLIENT_ID;
const CLIENT_SECRET = process.env.TTLOCK_CLIENT_SECRET;
const USERNAME = process.env.TTLOCK_USERNAME;

// ==============================
// HELPERS
// ==============================
function assertEnv() {
  const required = [
    "TTLOCK_CLIENT_ID",
    "TTLOCK_CLIENT_SECRET",
    "TTLOCK_USERNAME",
    "TTLOCK_PASSWORD",
    "ORG_ID",
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
// TTLOCK CALLS
// ==============================
async function ttlockPasswordGrant() {
  const passwordMd5 = crypto
    .createHash("md5")
    .update(process.env.TTLOCK_PASSWORD)
    .digest("hex");

  return postForm(`${API_BASE}/oauth2/token`, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    username: USERNAME,
    password: passwordMd5,
    grant_type: "password",
  });
}

async function ttlockRefresh(refreshToken) {
  return postForm(`${API_BASE}/oauth2/token`, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function getUid(accessToken) {
  return postForm(`${API_BASE}/v3/user/getUid`, {
    clientId: CLIENT_ID,
    accessToken,
    date: String(Date.now()),
  }).then((r) => r.uid);
}

// ==============================
// MAIN
// ==============================
async function main() {
  assertEnv();
 const force = process.env.FORCE_PASSWORD_GRANT === "1";

  const ORGANIZATION_ID = process.env.ORG_ID;

  const existing = await prisma.tTLockAuth.findUnique({
    where: { organizationId: ORGANIZATION_ID },
  });

let token;

if (!force && existing?.refreshToken) {
  try {
    token = await ttlockRefresh(existing.refreshToken);
    console.log("✅ Refresh token OK");
  } catch (e) {
    console.log("⚠️ Refresh falló, intentando password grant...");
    token = await ttlockPasswordGrant();
  }
} else {
  token = await ttlockPasswordGrant();
}


  const accessToken = token.access_token;
  const refreshToken = token.refresh_token;
  const expiresIn = Number(token.expires_in || 7200);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  if (!accessToken || !refreshToken) {
    throw new Error("Token inválido recibido desde TTLock");
  }

  const uid = await getUid(accessToken);

  await prisma.tTLockAuth.upsert({
    where: { organizationId: ORGANIZATION_ID },
    update: {
      uid,
      accessToken,
      refreshToken,
      expiresAt,
    },
    create: {
      organizationId: ORGANIZATION_ID,
      uid,
      accessToken,
      refreshToken,
      expiresAt,
    },
  });

  console.log("✅ TTLockAuth guardado correctamente");
  console.log({ organizationId: ORGANIZATION_ID, uid });
}

main()
  .catch((err) => {
    console.error("❌ ttlock-auth-sync error:");
    console.error(err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
