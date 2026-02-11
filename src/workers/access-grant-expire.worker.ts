import "dotenv/config";
import { prisma } from "../lib/prisma";
import { AccessStatus } from "@prisma/client";
import { activateGrant, deactivateGrant } from "../services/ttlock/ttlock.brain";

const POLL_MS = Number(process.env.ACCESS_GRANT_EXPIRE_POLL_MS ?? 30_000);
const BATCH_SIZE = Number(process.env.ACCESS_GRANT_EXPIRE_BATCH_SIZE ?? 50);

function toErrString(e: unknown) {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function tick() {
  const now = new Date();

  // 1) Activaciones: grants PENDING dentro de ventana
  const dueToActivate = await prisma.accessGrant.findMany({
    where: {
      status: AccessStatus.PENDING,
      startsAt: { lte: now },
      endsAt: { gt: now },
 
   },
    select: { id: true },
    take: BATCH_SIZE,
  });

  let activatedOk = 0;
  let activatedFail = 0;

  for (const g of dueToActivate) {
    try {
      await activateGrant(g.id);
      activatedOk++;

      await prisma.accessGrant.update({
        where: { id: g.id },
        data: { lastError: null },
      });
    } catch (e) {
      activatedFail++;
      await prisma.accessGrant.update({
        where: { id: g.id },
        data: { lastError: toErrString(e) },
      });
    }
  }

  // 2) Expiraciones / checkout: grants ACTIVE que ya vencieron
  const dueToDeactivate = await prisma.accessGrant.findMany({
    where: {
      status: AccessStatus.ACTIVE,
      endsAt: { lte: now },

    },
    select: { id: true },
    take: BATCH_SIZE,
  });

  let deactivatedOk = 0;
  let deactivatedFail = 0;

  for (const g of dueToDeactivate) {
    try {
      await deactivateGrant(g.id);
      deactivatedOk++;

      await prisma.accessGrant.update({
        where: { id: g.id },
        data: { lastError: null },
      });
    } catch (e) {
      deactivatedFail++;
      await prisma.accessGrant.update({
        where: { id: g.id },
        data: { lastError: toErrString(e) },
      });
    }
  }

  if (dueToActivate.length || dueToDeactivate.length) {
    console.log(
      `[access-grant-expire] activate: ok=${activatedOk} fail=${activatedFail} | ` +
        `deactivate: ok=${deactivatedOk} fail=${deactivatedFail}`
    );
  }
}

async function main() {
  console.log("[access-grant-expire] started");
  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
