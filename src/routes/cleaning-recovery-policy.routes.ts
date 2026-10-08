import { Router, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth.js";
import { readCleaningRecoveryPolicy, saveCleaningRecoveryPolicy, CleaningRecoveryPolicyError } from "../services/cleaning-recovery-policy.service.js";

export function buildCleaningRecoveryPolicyRouter(db: PrismaClient, authenticate: RequestHandler = requireAuth) {
  const router = Router();
  const path = "/api/properties/:propertyId/cleaning-recovery-policy";
  router.use(path, authenticate, (req: any, res, next) => {
    if (!["ADMIN", "ORG_ADMIN", "PLATFORM_ADMIN"].includes(req.user?.role)) return res.status(403).json({ error: "HOST_ADMIN_REQUIRED" });
    return next();
  });
  const fail = (res: any, error: unknown) => res.status(error instanceof CleaningRecoveryPolicyError ? error.status : 500).json({ error: error instanceof CleaningRecoveryPolicyError ? error.code : "CLEANING_RECOVERY_POLICY_FAILED" });
  router.get(path, async (req: any, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      return res.json(await readCleaningRecoveryPolicy(db, { propertyId: String(req.params.propertyId), organizationId: req.user.orgId }));
    } catch (error) { return fail(res, error); }
  });
  router.put(path, async (req: any, res) => {
    try {
      return res.json(await saveCleaningRecoveryPolicy(db, { propertyId: String(req.params.propertyId), organizationId: req.user.orgId, userId: req.user.id }, req.body));
    } catch (error) { return fail(res, error); }
  });
  return router;
}
