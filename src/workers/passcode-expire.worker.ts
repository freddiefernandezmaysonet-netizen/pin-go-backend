import "dotenv/config";
import { prisma } from "../lib/prisma";
import { ttlockDeleteKeyboardPwd } from "../ttlock/ttlock.service"; // ✅ AJUSTA si tu función está en otro path

// helper: errores TTLock tipo "ya no existe"
function isNotFoundLike(err: any) {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("not found") || msg.includes("no data") || msg.includes("404");
}

async function tick() {
  const now = new Date();

  const grants = await prisma.accessGrant.findMany({
    where: {
      method: "PASSCODE_TIMEBOUND",
      status: "ACTIVE",
      endsAt: { lte: now },
    },
    include: { lock: true },
    take: 50,
  });

  for (const g of grants) {
    try {
      // 1) Revocar en TTLock si existe keyboardPwdId
      if (g.ttlockKeyboardPwdId && g.lock?.ttlockLockId) {
        await ttlockDeleteKeyboardPwd({
          lockId: Number(g.lock.ttlockLockId),
          keyboardPwdId: Number(g.ttlockKeyboardPwdId),
        });
      }

      // 2) Marcar como REVOKED en DB
      await prisma.accessGrant.update({
        where: { id: g.id },
        data: { status: "REVOKED", lastError: null },
      });
    } catch (e: any) {
      // Si TTLock dice "no existe", igual lo damos por revocado
      if (isNotFoundLike(e)) {
        await prisma.accessGrant.update({
          where: { id: g.id },
          data: { status: "REVOKED", lastError: null },
        });
        continue;
      }

      // Error real → lo dejamos registrado para retry
      await prisma.accessGrant.update({
        where: { id: g.id },
        data: { lastError: String(e?.message ?? e) },
      });
    }
  }

  if (grants.length > 0) {
    console.log(`[passcode-expire] processed=${grants.length} at=${now.toISOString()}`);
  }
}

async function main() {
  console.log("[passcode-expire] worker started");
  await tick();
  const interval = setInterval(() => void tick(), 30_000);

  const shutdown = async () => {
    clearInterval(interval);
    try {
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main()
  .catch((e) => {
    console.error("[passcode-expire] fatal:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // por si algo falla antes de montar handlers
    await prisma.$disconnect();
  });
