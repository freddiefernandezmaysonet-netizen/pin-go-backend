import "dotenv/config";
import { prisma } from "../lib/prisma";

const POLL_MS = Number(process.env.ACCESS_CODE_CLEANUP_POLL_MS ?? 60_000);

function toErrString(e: unknown) {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function tick() {
  const now = new Date();

  try {
    // Borra SOLO el encrypted cuando expira (mantén hash/masked para auditoría)
    const res = await prisma.accessCode.updateMany({
      where: {
        expiresAt: { lte: now },
        accessCodeEnc: { not: null },
      },
      data: {
        accessCodeEnc: null,
      },
    });

    if (res.count) console.log(`[access-code-cleanup] cleared_enc=${res.count}`);
  } catch (e) {
    // Si AccessCode no existe / migración incompleta / etc., no queremos que el proceso muera.
    console.error("[access-code-cleanup] tick failed:", toErrString(e));
  }
}

async function main() {
  console.log("[access-code-cleanup] started");
  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
