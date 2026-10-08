import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth.js";
import { assertCleanerIdentity } from "../auth/cleaner-surface.policy.js";
import { CleaningChecklistError, readOwnChecklist, saveChecklistTemplate, setChecklistItem } from "../services/cleaning-checklist.service.js";
import { CleaningActionWindowError } from "../services/cleaning-action-window.js";
export function buildCleaningChecklistRouter(db: PrismaClient) {
  const router = Router();
  const fail = (res: any, error: unknown) => res.status(error instanceof CleaningChecklistError ? error.status : error instanceof CleaningActionWindowError ? 409 : 500).json({ error: error instanceof CleaningChecklistError ? error.code : error instanceof CleaningActionWindowError ? error.message : "CHECKLIST_REQUEST_FAILED" });
  router.use("/api/properties/:propertyId/cleaning-checklist", requireAuth, async (req: any, res, next) => {
    if (!["ADMIN", "ORG_ADMIN", "PLATFORM_ADMIN"].includes(req.user?.role)) return res.status(403).json({ error: "HOST_ADMIN_REQUIRED" });
    try {
      const property = await db.property.findFirst({ where: { id: String(req.params.propertyId), organizationId: req.user.orgId }, select: { id: true } });
      if (!property) return res.status(404).json({ error: "PROPERTY_NOT_FOUND" });
      return next();
    } catch (error) { return fail(res, error); }
  });
  router.get("/api/properties/:propertyId/cleaning-checklist", async (req, res) => {
    try { res.setHeader("Cache-Control", "no-store"); return res.json(await db.cleaningChecklistTemplate.findUnique({ where: { propertyId: String(req.params.propertyId) } }) ?? { revision: 0, items: [] }); }
    catch (error) { return fail(res, error); }
  });
  router.put("/api/properties/:propertyId/cleaning-checklist", async (req: any, res) => {
    try { return res.json(await saveChecklistTemplate(db, { propertyId: String(req.params.propertyId), organizationId: req.user.orgId, userId: req.user.id, revision: req.body?.revision, items: req.body?.items })); }
    catch (error) { return fail(res, error); }
  });
  const identity = async (req: any) => {
    const staff = await db.staffMember.findUnique({ where: { dashboardUserId: req.user.id } });
    try { assertCleanerIdentity(req.user, staff); } catch { throw new CleaningChecklistError("CLEANER_IDENTITY_REQUIRED", 403); }
    return { confirmationId: String(req.params.id), staffMemberId: staff!.id, organizationId: req.user.orgId };
  };
  router.get("/api/cleaner/cleanings/:id/checklist", requireAuth, async (req: any, res) => {
    try { res.setHeader("Cache-Control", "no-store"); return res.json(await readOwnChecklist(db, await identity(req))); }
    catch (error) { return fail(res, error); }
  });
  router.patch("/api/cleaner/cleanings/:id/checklist/:itemId", requireAuth, async (req: any, res) => {
    try { return res.json(await setChecklistItem(db, { ...await identity(req), itemId: String(req.params.itemId), checked: req.body?.checked, version: req.body?.version })); }
    catch (error) { return fail(res, error); }
  });
  return router;
}
