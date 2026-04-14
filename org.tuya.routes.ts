import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { getValidTuyaAccessToken } from "../integrations/tuya/tuya.auth";
import { tuyaRequest } from "../integrations/tuya/tuya.http";

const prisma = new PrismaClient();
const router = Router();

type AuthedRequest = Request & {
  user?: {
    orgId?: string;
  };
};

router.use(requireAuth);

/**
 * 🔍 STATUS
 */
router.get("/api/org/tuya/status", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    }

    const integration = await prisma.integrationAccount.findUnique({
      where: {
        organizationId_provider: {
          organizationId: orgId,
          provider: "TUYA",
        },
      },
    });

    return res.json({
      ok: true,
      linked: Boolean(integration?.externalUid),
      uid: integration?.externalUid ?? null,
      status: integration?.status ?? "NOT_LINKED",
    });
  } catch (err: any) {
    console.error("[tuya.status] error", err);
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * 🔗 LINK
 */
router.post("/api/org/tuya/link", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();
    const uid = String(req.body?.uid ?? "").trim();

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    }

    if (!uid) {
      return res.status(400).json({ ok: false, error: "UID_REQUIRED" });
    }

    await prisma.integrationAccount.upsert({
      where: {
        organizationId_provider: {
          organizationId: orgId,
          provider: "TUYA",
        },
      },
      update: {
        externalUid: uid,
        status: "LINKED",
        linkedAt: new Date(),
      },
      create: {
        organizationId: orgId,
        provider: "TUYA",
        externalUid: uid,
        status: "LINKED",
        linkedAt: new Date(),
      },
    });

    return res.json({
      ok: true,
      uid,
      message: "Tuya linked successfully",
    });
  } catch (err: any) {
    console.error("[tuya.link] error", err);
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * ❌ UNLINK
 */
router.post("/api/org/tuya/unlink", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    }

    await prisma.integrationAccount.updateMany({
      where: {
        organizationId: orgId,
        provider: "TUYA",
      },
      data: {
        externalUid: null,
        status: "DISABLED",
      },
    });

    return res.json({
      ok: true,
      message: "Tuya unlinked",
    });
  } catch (err: any) {
    console.error("[tuya.unlink] error", err);
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * 📦 DEVICES POR ORGANIZACIÓN
 */
router.get("/api/org/tuya/devices", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    }

    const integration = await prisma.integrationAccount.findUnique({
      where: {
        organizationId_provider: {
          organizationId: orgId,
          provider: "TUYA",
        },
      },
    });

    if (!integration?.externalUid) {
      return res.status(400).json({
        ok: false,
        error: "TUYA_NOT_LINKED",
      });
    }

    const accessToken = await getValidTuyaAccessToken();

    const resp = await tuyaRequest<any[]>({
      method: "GET",
      path: `/v1.0/users/${integration.externalUid}/devices`,
      accessToken,
    });

    if (!resp.success) {
      return res.status(500).json({
        ok: false,
        error: resp.msg ?? "Failed to fetch devices",
      });
    }

    return res.json({
      ok: true,
      count: Array.isArray(resp.result) ? resp.result.length : 0,
      items: resp.result ?? [],
    });
  } catch (err: any) {
    console.error("[tuya.devices] error", err);
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

export default router;