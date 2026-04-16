// src/middleware/requireLockCapacity.ts
import { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";

export function requireLockCapacity(prisma: PrismaClient) {
  return async (req: any, res: any, next: any) => {
    try {
      const organizationId = String(
        req.user?.orgId ??
          req.orgId ??
          req.body?.organizationId ??
          req.body?.orgId ??
          req.params?.orgId ??
          req.query?.organizationId ??
          ""
      ).trim();

      if (!organizationId) {
        return res
          .status(400)
          .json({ ok: false, error: "Missing organizationId" });
      }

      const result = await assertLockCapacity(prisma, organizationId, 1);

      if (!result.ok) {
        return res.status(402).json({
          ok: false,
          code: result.code,
          entitledLocks: result.entitled,
          usedLocks: result.used,
        });
      }

      next();
    } catch (e: any) {
      return res
        .status(500)
        .json({ ok: false, error: e?.message ?? String(e) });
    }
  };
}