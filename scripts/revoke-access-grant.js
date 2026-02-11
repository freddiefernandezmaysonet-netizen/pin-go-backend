// scripts/revoke-access-grant.js
import dotenv from "dotenv";
dotenv.config({ override: true });
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function assertEnv() {
  const required = ["ORG_ID", "ACCESS_GRANT_ID"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Faltan env vars: ${missing.join(", ")}`);
  }
}

async function revokeKeyboardPwd({ accessToken, lockId, keyboardPwdId }) {
  const url = `${process.env.TTLOCK_API_BASE}/v3/keyboardPwd/delete`;
  const body = new URLSearchParams({
    clientId: process.env.TTLOCK_CLIENT_ID,
    accessToken,
    lockId: String(lockId),
    keyboardPwdId: String(keyboardPwdId),
    date: String(Date.now()),
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json();
  if (json.errcode) {
    throw new Error(`TTLock delete keyboardPwd error: ${json.errmsg}`);
  }
}

async function main() {
  assertEnv();

  const ORG_ID = process.env.ORG_ID;
  const ACCESS_GRANT_ID = process.env.ACCESS_GRANT_ID;

  const grant = await prisma.accessGrant.findUnique({
    where: { id: ACCESS_GRANT_ID },
    include: {
      lock: {
        select: {
          id: true,
          ttlockLockId: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });

  if (!grant) throw new Error("AccessGrant no encontrado");

  if (grant.lock.property.organizationId !== ORG_ID) {
    throw new Error("Este AccessGrant no pertenece a tu ORG_ID");
  }

  if (!grant.ttlockKeyboardPwdId && !grant.ttlockKeyId) {
    throw new Error("Este AccessGrant no tiene credenciales TTLock que revocar");
  }

  // Obtener accessToken válido
  const auth = await prisma.tTLockAuth.findUnique({
    where: { organizationId: ORG_ID },
  });

  if (!auth?.accessToken) {
    throw new Error("No hay TTLockAuth válido");
  }

  // Revocar passcode si existe
  if (grant.ttlockKeyboardPwdId) {
    await revokeKeyboardPwd({
      accessToken: auth.accessToken,
      lockId: grant.lock.ttlockLockId,
      keyboardPwdId: grant.ttlockKeyboardPwdId,
    });
  }

  // Marcar como REVOKED en DB
  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: {
      status: "REVOKED",
      endsAt: new Date(),
    },
  });

  console.log("✅ AccessGrant revocado correctamente:");
  console.log({
    accessGrantId: grant.id,
    ttlockKeyboardPwdId: grant.ttlockKeyboardPwdId,
    status: "REVOKED",
  });
}

main()
  .catch((e) => {
    console.error("❌ revoke-access-grant error:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
