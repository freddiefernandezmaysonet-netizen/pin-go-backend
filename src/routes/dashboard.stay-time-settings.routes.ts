import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedUser } from "../middleware/requireAuth.js";
import { StayTimeSettingsError } from "../pin-ai/actions/stay-time-settings.js";
import {
  getPropertyStayTimeSettings, updatePropertyStayTimeSettings, type StayTimeSettingsDb,
} from "../services/property-stay-time-settings.service.js";

const ADMIN_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);
function actor(req: Request) { return (req as Request & { user: AuthenticatedUser }).user; }
function failure(res: Response, error: unknown) {
  if (error instanceof StayTimeSettingsError) return res.status(error.status).json({ ok: false, error: error.code });
  console.error("[STAY_TIME_SETTINGS_ERROR]", error);
  return res.status(500).json({ ok: false, error: "STAY_TIME_SETTINGS_UNAVAILABLE" });
}
export function buildDashboardStayTimeSettingsRouter(db: StayTimeSettingsDb) {
  const router = Router();
  const path = "/api/dashboard/properties/:propertyId/stay-time-settings";
  router.use(path, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }, requireAuth,
    (req, res, next) => {
      const user = actor(req);
      if (!user?.id || !user.orgId || !user.role || !ADMIN_ROLES.has(user.role)) {
        return res.status(403).json({ ok: false, error: "STAY_TIME_SETTINGS_FORBIDDEN" });
      }
      next();
    });
  router.get(path, async (req, res) => {
    try { res.json({ ok: true, ...await getPropertyStayTimeSettings(db, actor(req).orgId, String(req.params.propertyId)) }); }
    catch (error) { failure(res, error); }
  });
  router.put(path, async (req, res) => {
    try { res.json({ ok: true, ...await updatePropertyStayTimeSettings(db, actor(req).orgId, String(req.params.propertyId), req.body) }); }
    catch (error) { failure(res, error); }
  });
  return router;
}
