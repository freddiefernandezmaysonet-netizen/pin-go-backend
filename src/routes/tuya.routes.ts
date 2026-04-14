import { Router } from "express";
import type { Request, Response } from "express";
import { TUYA_BASE_URL, TUYA_ENABLED } from "../integrations/tuya/tuya.config";
import {
  getTuyaToken,
  getValidTuyaAccessToken,
  clearTuyaTokenCache,
} from "../integrations/tuya/tuya.auth";
import { tuyaRequest } from "../integrations/tuya/tuya.http";

const router = Router();

function getDebugUid(req: Request) {
  const fromQuery = String(req.query.uid ?? "").trim();
  const fromEnv = String(process.env.TUYA_DEBUG_UID ?? "").trim();
  return fromQuery || fromEnv || "";
}

/**
 * 🧪 Ping
 */
router.get("/api/dev/tuya/ping", (_req: Request, res: Response) => {
  console.log("[tuya] ping hit");
  return res.json({ ok: true, message: "pong" });
});

/**
 * 🧪 Health (SIN CACHE)
 * Solo valida token del proyecto cloud.
 * Ya NO usa token.uid porque ese no es el UID correcto para producción.
 */
router.get("/api/dev/tuya/health", async (_req: Request, res: Response) => {
  console.log("[tuya] health hit");

  try {
    if (!TUYA_ENABLED) {
      return res.json({
        ok: true,
        enabled: false,
        tokenOk: false,
        baseUrl: TUYA_BASE_URL || null,
      });
    }

    clearTuyaTokenCache();
    const token = await getTuyaToken(true);

    console.log("[tuya] health token", {
      hasAccessToken: Boolean(token.access_token),
      expireTime: token.expire_time,
      accessTokenPreview: token.access_token?.slice(0, 10),
    });

    return res.json({
      ok: true,
      enabled: true,
      tokenOk: true,
      hasAccessToken: Boolean(token.access_token),
      expiresInSec: token.expire_time,
      baseUrl: TUYA_BASE_URL,
    });
  } catch (err: any) {
    console.error("[tuya] health error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

/**
 * 🧪 USER INFO (SIN CACHE)
 * Requiere UID por query (?uid=...) o env TUYA_DEBUG_UID
 */
router.get("/api/dev/tuya/user-info", async (req: Request, res: Response) => {
  console.log("[tuya] user-info hit");

  try {
    if (!TUYA_ENABLED) {
      return res.status(400).json({
        ok: false,
        error: "Tuya integration disabled",
      });
    }

    const uid = getDebugUid(req);
    if (!uid) {
      return res.status(400).json({
        ok: false,
        error: "DEBUG_UID_REQUIRED",
        hint: "Usa ?uid=... o define TUYA_DEBUG_UID",
      });
    }

    clearTuyaTokenCache();
    const accessToken = await getValidTuyaAccessToken();

    console.log("[tuya] user-info token ok", {
      uid,
      hasAccessToken: Boolean(accessToken),
    });

    const resp = await tuyaRequest<any>({
      method: "GET",
      path: `/v1.0/users/${uid}/infos`,
      accessToken,
    });

    console.log("[tuya] user-info response", {
      uid,
      success: resp.success,
      code: resp.code,
      msg: resp.msg,
      tid: (resp as any).tid,
      t: resp.t,
    });

    if (!resp.success) {
      return res.status(500).json({
        ok: false,
        error: resp.msg ?? resp.code ?? "Failed to fetch user info",
        tuya: {
          code: resp.code,
          msg: resp.msg,
          tid: (resp as any).tid,
          t: resp.t,
        },
      });
    }

    return res.json({
      ok: true,
      uid,
      user: resp.result,
    });
  } catch (err: any) {
    console.error("[tuya] user-info error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

/**
 * 🧪 DEVICES (SIN CACHE)
 * Requiere UID por query (?uid=...) o env TUYA_DEBUG_UID
 */
router.get("/api/dev/tuya/devices", async (req: Request, res: Response) => {
  console.log("[tuya] devices hit");

  try {
    if (!TUYA_ENABLED) {
      return res.status(400).json({
        ok: false,
        error: "Tuya integration disabled",
      });
    }

    const uid = getDebugUid(req);
    if (!uid) {
      return res.status(400).json({
        ok: false,
        error: "DEBUG_UID_REQUIRED",
        hint: "Usa ?uid=... o define TUYA_DEBUG_UID",
      });
    }

    clearTuyaTokenCache();
    const accessToken = await getValidTuyaAccessToken();

    const resp = await tuyaRequest<any[]>({
      method: "GET",
      path: `/v1.0/users/${uid}/devices`,
      accessToken,
    });

    console.log("[tuya] devices response", {
      uid,
      success: resp.success,
      code: resp.code,
      msg: resp.msg,
      tid: (resp as any).tid,
      count: Array.isArray(resp.result) ? resp.result.length : null,
    });

    if (!resp.success) {
      return res.status(500).json({
        ok: false,
        error: resp.msg ?? resp.code ?? "Failed to fetch devices",
        tuya: {
          code: resp.code,
          msg: resp.msg,
          tid: (resp as any).tid,
          t: resp.t,
        },
      });
    }

    return res.json({
      ok: true,
      uid,
      count: Array.isArray(resp.result) ? resp.result.length : 0,
      devices: resp.result ?? [],
    });
  } catch (err: any) {
    console.error("[tuya] devices error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

/**
 * 🔧 RESET MANUAL (opcional)
 */
router.post("/api/dev/tuya/reset", (_req: Request, res: Response) => {
  clearTuyaTokenCache();
  console.log("[tuya] cache manually cleared");

  return res.json({
    ok: true,
    message: "Cache cleared",
  });
});

export default router;