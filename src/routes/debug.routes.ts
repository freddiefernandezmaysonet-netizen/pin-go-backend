import { Router } from "express";
import { ttlockListCards } from "../ttlock/ttlock.card";

export const debugRouter = Router();

debugRouter.get("/ttlock/cards", async (req, res) => {
  try {
    const lockId = Number(req.query.lockId);
    if (!lockId) return res.status(400).json({ ok: false, error: "Missing lockId" });

    const data = await ttlockListCards({ lockId, pageNo: 1, pageSize: 200 });
    return res.json({ ok: true, lockId, data });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});