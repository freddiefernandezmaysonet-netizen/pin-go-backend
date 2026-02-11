import { Router } from "express";
import { PrismaClient, AccessMethod, AccessStatus } from "@prisma/client";
// import { activateGrant, deactivateGrant } from "../services/grantActions.service";

const prisma = new PrismaClient();
const r = Router();

// Seguridad simple para dev
function requireDevKey(req: any, res: any, next: any) {
  const key = req.header("x-dev-key");
  if (!process.env.DEV_KEY || key !== process.env.DEV_KEY) {
    return res.status(401).json({ ok: false, error: "DEV_KEY invalid" });
  }
  next();
}

r.post("/grants/:id/force-activate", requireDevKey, async (req, res) => {
  const id = req.params.id;

  const grant = await prisma.accessGrant.findUnique({
    where: { id },
    include: { lock: true, reservation: true },
  });

  if (!grant) return res.status(404).json({ ok: false, error: "Grant not found" });

  if (grant.method !== AccessMethod.PASSCODE_TIMEBOUND) {
    return res.status(400).json({ ok: false, error: "Only PASSCODE_TIMEBOUND supported" });
  }

  try {
    const payload: any = await (global as any).activateGrant(grant); // ver nota abajo

    await prisma.accessGrant.update({
      where: { id },
      data: {
        status: AccessStatus.ACTIVE,
        ttlockKeyboardPwdId: payload.ttlockKeyboardPwdId ?? null,
        ttlockPayload: payload.ttlockPayload ?? null,
        unlockKey: payload.unlockKey ?? "#",
        accessCodeMasked: payload.accessCodeMasked ?? null,
        lastError: null,
      },
    });

    return res.json({ ok: true, grantId: id, payload });
  } catch (e: any) {
    await prisma.accessGrant.update({
      where: { id },
      data: { lastError: String(e?.message ?? e), status: AccessStatus.FAILED },
    });

    return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

export default r;
