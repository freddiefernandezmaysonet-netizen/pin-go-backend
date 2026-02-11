import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// cada 5 minutos
const INTERVAL_MS = Number(process.env.ACCESSCODE_CLEANUP_INTERVAL_MS ?? 5 * 60 * 1000);

async function cleanupOnce() {
  const now = new Date();

  const result = await prisma.accessCode.updateMany({
    where: {
      expiresAt: { lte: now },
      accessCodeEnc: { not: null },
    },
    data: {
      accessCodeEnc: null,
    },
  });

  if (result.count > 0) {
    console.log(`[accesscode-cleanup] cleared accessCodeEnc for ${result.count} rows @ ${now.toISOString()}`);
  } else {
    console.log(`[accesscode-cleanup] nothing to clear @ ${now.toISOString()}`);
  }
}

async function start() {
  console.log(`[accesscode-cleanup] starting. interval=${INTERVAL_MS}ms`);

  // primer tick inmediato
  try {
    await cleanupOnce();
  } catch (e: any) {
    console.error("[accesscode-cleanup] first run failed:", e?.message ?? e);
  }

  // loop
  const timer = setInterval(() => {
    cleanupOnce().catch((e: any) => {
      console.error("[accesscode-cleanup] tick failed:", e?.message ?? e);
    });
  }, INTERVAL_MS);

  // shutdown clean
  const shutdown = async (sig: string) => {
    console.log(`[accesscode-cleanup] shutting down (${sig})...`);
    clearInterval(timer);
    try {
      await prisma.$disconnect();
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((e) => {
  console.error("[accesscode-cleanup] crashed:", e);
  process.exit(1);
});
