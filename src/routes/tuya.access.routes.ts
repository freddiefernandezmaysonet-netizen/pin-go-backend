import { Router, type Request, type Response } from "express";
import {
  requireTuyaConnected,
  requireTuyaEntitlement,
  resolveTuyaAccess,
} from "../middleware/requireTuyaEntitlement";

type PrismaLike = any;

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveOrgId(req: Request): string | null {
  const fromReq = normalizeString((req as any).orgId);
  if (fromReq) return fromReq;

  const fromOrg = normalizeString((req as any).org?.id);
  if (fromOrg) return fromOrg;

  const fromUser = normalizeString((req as any).user?.orgId);
  if (fromUser) return fromUser;

  const fromBody = normalizeString((req as any).body?.organizationId);
  if (fromBody) return fromBody;

  const fromQuery = normalizeString((req as any).query?.organizationId);
  if (fromQuery) return fromQuery;

  return null;
}

export function buildTuyaAccessRouter(prisma: PrismaLike) {
  const router = Router();

  /**
   * GET /api/org/tuya/access/status
   *
   * Devuelve el estado que necesita la UI:
   * - locked
   * - pending_onboarding
   * - connected
   */
  router.get("/status", async (req: Request, res: Response) => {
    try {
      const orgId = resolveOrgId(req);
      const access = await resolveTuyaAccess(prisma, orgId);

      if (!access.orgId) {
        return res.status(400).json({
          ok: false,
          error: "ORGANIZATION_ID_REQUIRED",
          tuya: access,
        });
      }

      return res.json({
        ok: true,
        tuya: {
          ...access,
          ui: {
            state: access.state,
            locked: access.state === "locked",
            pendingOnboarding: access.state === "pending_onboarding",
            connected: access.state === "connected",
            canOpenPremiumCheckout: access.state === "locked",
            canStartOnboarding: access.state === "pending_onboarding",
            canManageDevices: access.state === "connected",
          },
        },
      });
    } catch (error: any) {
      return res.status(500).json({
        ok: false,
        error: "TUYA_ACCESS_STATUS_FAILED",
        message:
          error?.message || "Unexpected error while reading Tuya access status",
      });
    }
  });

  /**
   * GET /api/org/tuya/access/entitlement
   *
   * Pasa solo si la organización tiene entitlement Tuya.
   * Si no está conectada todavía, igual entra.
   */
  router.get(
    "/entitlement",
    requireTuyaEntitlement(prisma),
    async (req: Request, res: Response) => {
      return res.json({
        ok: true,
        tuya: (req as any).tuyaAccess ?? null,
      });
    }
  );

  /**
   * GET /api/org/tuya/access/connected
   *
   * Pasa solo si:
   * - tiene entitlement
   * - ya completó onboarding / UID conectado
   */
  router.get(
    "/connected",
    requireTuyaConnected(prisma),
    async (req: Request, res: Response) => {
      return res.json({
        ok: true,
        tuya: (req as any).tuyaAccess ?? null,
      });
    }
  );

  return router;
}

export default buildTuyaAccessRouter;