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

type TuyaDeviceProfile =
  | "LIGHT_BASIC"
  | "LIGHT_COLOR"
  | "SWITCH_BASIC"
  | "AC_BASIC"
  | "CURTAIN_BASIC"
  | "ALARM_BASIC"
  | "LOCK_BASIC"
  | "UNKNOWN";

type TuyaFunctionItem = {
  code?: string;
  desc?: string;
  name?: string;
  type?: string;
  values?: string;
};

function detectDeviceProfile(functions: TuyaFunctionItem[]): TuyaDeviceProfile {
  const codes = new Set(
    functions
      .map((f) => String(f?.code ?? "").trim().toLowerCase())
      .filter(Boolean)
  );

  const has = (code: string) => codes.has(code.toLowerCase());

  if (has("switch_led") && (has("colour_data") || has("colour_data_v2"))) {
    return "LIGHT_COLOR";
  }

  if (has("switch_led")) {
    return "LIGHT_BASIC";
  }

  if (has("temp_set") && has("mode")) {
    return "AC_BASIC";
  }

  if (has("switch")) {
    return "SWITCH_BASIC";
  }

  if (has("control")) {
    return "CURTAIN_BASIC";
  }

  if (has("alarm_switch")) {
    return "ALARM_BASIC";
  }

  if (has("closed_opened")) {
    return "LOCK_BASIC";
  }

  return "UNKNOWN";
}

async function getTuyaDeviceFunctions(
  externalId: string,
  accessToken: string
): Promise<TuyaFunctionItem[]> {
  try {
    const resp = await tuyaRequest<any>({
      method: "GET",
      path: `/v1.0/iot-03/devices/${externalId}/functions`,
      accessToken,
    });

    if (!resp.success) {
      console.warn("[org.tuya.devices] Tuya functions request failed", {
        externalId,
        code: resp.code,
        msg: resp.msg,
      });
      return [];
    }

console.log("[org.tuya.devices] functions raw response", {
  externalId,
  result: resp.result,
});
    
    if (Array.isArray(resp.result)) {
      return resp.result;
    }

    if (Array.isArray(resp.result?.functions)) {
      return resp.result.functions;
    }

    console.warn("[org.tuya.devices] Tuya functions response shape not recognized", {
      externalId,
      result: resp.result,
    });

    return [];
  } catch (err) {
    console.warn("[org.tuya.devices] failed to fetch device functions", {
      externalId,
      error: String((err as any)?.message ?? err),
    });
    return [];
  }
}

router.use(requireAuth);

/**
 * GET /api/org/tuya/status
 */
router.get("/api/org/tuya/status", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();

    if (!orgId) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHENTICATED",
      });
    }

    const integration = await prisma.integrationAccount.findUnique({
      where: {
        organizationId_provider: {
          organizationId: orgId,
          provider: "TUYA",
        },
      },
    });

    const linkedUid = String(integration?.externalUid ?? "").trim();

    return res.json({
      ok: true,
      linked: Boolean(linkedUid && integration?.status === "LINKED"),
      integration: integration
        ? {
            provider: integration.provider,
            status: integration.status,
            externalUid: integration.externalUid,
            linkedAt: integration.linkedAt,
            updatedAt: integration.updatedAt,
          }
        : null,
    });
  } catch (err: any) {
    console.error("[org.tuya.status] error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

/**
 * POST /api/org/tuya/link
 */
router.post("/api/org/tuya/link", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();
    const uid = String(req.body?.uid ?? "").trim();

    if (!orgId) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHENTICATED",
      });
    }

    if (!uid) {
      return res.status(400).json({
        ok: false,
        error: "UID_REQUIRED",
      });
    }

    const integration = await prisma.integrationAccount.upsert({
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
      integration,
    });
  } catch (err: any) {
    console.error("[org.tuya.link] error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

/**
 * POST /api/org/tuya/unlink
 */
router.post("/api/org/tuya/unlink", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();

    if (!orgId) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHENTICATED",
      });
    }

    const existing = await prisma.integrationAccount.findUnique({
      where: {
        organizationId_provider: {
          organizationId: orgId,
          provider: "TUYA",
        },
      },
    });

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: "TUYA_NOT_LINKED",
      });
    }

    const integration = await prisma.integrationAccount.update({
      where: {
        organizationId_provider: {
          organizationId: orgId,
          provider: "TUYA",
        },
      },
      data: {
        status: "UNLINKED",
      },
    });

    return res.json({
      ok: true,
      integration,
    });
  } catch (err: any) {
    console.error("[org.tuya.unlink] error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

/**
 * GET /api/org/tuya/devices
 */
router.get("/api/org/tuya/devices", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();

    if (!orgId) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHENTICATED",
      });
    }

    const integration = await prisma.integrationAccount.findUnique({
      where: {
        organizationId_provider: {
          organizationId: orgId,
          provider: "TUYA",
        },
      },
    });

    const linkedUid = String(integration?.externalUid ?? "").trim();

    if (!linkedUid || integration?.status !== "LINKED") {
      return res.status(404).json({
        ok: false,
        error: "TUYA_NOT_LINKED",
      });
    }

    const accessToken = await getValidTuyaAccessToken();

    const resp = await tuyaRequest<any[]>({
      method: "GET",
      path: `/v1.0/users/${linkedUid}/devices`,
      accessToken,
    });

    if (!resp.success) {
      return res.status(500).json({
        ok: false,
        error: resp.msg ?? resp.code ?? "Failed to fetch Tuya devices",
        tuya: {
          code: resp.code,
          msg: resp.msg,
          tid: (resp as any).tid,
          t: resp.t,
        },
      });
    }

    const rawDevices = Array.isArray(resp.result) ? resp.result : [];
    const externalIds = rawDevices
      .map((d: any) => String(d?.id ?? "").trim())
      .filter((id) => id.length > 0);

    const [automationAssignments, propertyDevices] = await Promise.all([
      externalIds.length > 0
        ? prisma.propertyAutomationDevice.findMany({
            where: {
              organizationId: orgId,
              provider: "TUYA",
              externalDeviceId: { in: externalIds },
            },
            select: {
              externalDeviceId: true,
              deviceName: true,
              deviceCategory: true,
              propertyId: true,
              property: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          })
        : Promise.resolve([]),
      externalIds.length > 0
        ? prisma.propertyDevice.findMany({
            where: {
              organizationId: orgId,
              provider: "TUYA",
              externalId: { in: externalIds },
            },
            select: {
              externalId: true,
              name: true,
              type: true,
              propertyId: true,
              property: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const automationMap = new Map<
      string,
      {
        deviceName: string | null;
        deviceCategory: string | null;
        propertyId: string;
        propertyName: string;
      }
    >();

    for (const row of automationAssignments) {
      const externalId = String(row.externalDeviceId ?? "").trim();
      if (!externalId) continue;

      automationMap.set(externalId, {
        deviceName: row.deviceName ?? null,
        deviceCategory: row.deviceCategory ?? null,
        propertyId: row.propertyId,
        propertyName: row.property?.name ?? "Property",
      });
    }

    const propertyDeviceMap = new Map<
      string,
      {
        name: string | null;
        type: string | null;
        propertyId: string;
        propertyName: string;
      }
    >();

    for (const row of propertyDevices) {
      const externalId = String(row.externalId ?? "").trim();
      if (!externalId) continue;

      propertyDeviceMap.set(externalId, {
        name: row.name ?? null,
        type: row.type ?? null,
        propertyId: row.propertyId,
        propertyName: row.property?.name ?? "Property",
      });
    }

    const items = await Promise.all(
      rawDevices.map(async (d: any) => {
        const externalDeviceId = String(d?.id ?? "").trim();
        const tuyaName = String(d?.name ?? "").trim();
        const tuyaCategory =
          d?.category == null || String(d.category).trim() === ""
            ? null
            : String(d.category).trim();
        const productName = String(d?.product_name ?? "").trim();

        const automationMatch = automationMap.get(externalDeviceId) ?? null;
        const propertyDeviceMatch = propertyDeviceMap.get(externalDeviceId) ?? null;

        const resolvedName =
          tuyaName ||
          String(automationMatch?.deviceName ?? "").trim() ||
          String(propertyDeviceMatch?.name ?? "").trim() ||
          productName ||
          tuyaCategory ||
          "Unnamed device";

        const resolvedCategory =
          tuyaCategory ||
          automationMatch?.deviceCategory ||
          propertyDeviceMatch?.type ||
          null;

        const assignment = automationMatch
          ? {
              propertyId: automationMatch.propertyId,
              propertyName: automationMatch.propertyName,
            }
          : propertyDeviceMatch
          ? {
              propertyId: propertyDeviceMatch.propertyId,
              propertyName: propertyDeviceMatch.propertyName,
            }
          : null;

        const functions = externalDeviceId
          ? await getTuyaDeviceFunctions(externalDeviceId, accessToken)
          : [];

        const deviceProfile = detectDeviceProfile(functions);

        console.log("[org.tuya.devices] persist debug", {
  externalDeviceId,
  functionCodes: functions.map((f) => String(f?.code ?? "").trim().toLowerCase()),
  detectedProfile: deviceProfile,
});
       
    console.log("[org.tuya.devices] about to persist", {
  externalDeviceId,
  deviceProfile,
  functionsLength: functions.length,
});

      try {
          await prisma.propertyAutomationDevice.updateMany({
            where: {
              organizationId: orgId,
              provider: "TUYA",
              externalDeviceId,
            },
            data: {
              deviceProfile,
              tuyaFunctions: functions as any,
              profileSource: "AUTO_CAPABILITIES",
              profileDetectedAt: new Date(),
            },
          });
        } catch (err) {
          console.warn("[org.tuya.devices] failed to persist device profile", {
            externalDeviceId,
            error: String((err as any)?.message ?? err),
          });
        }

const persistResult = await prisma.propertyAutomationDevice.updateMany({
  where: {
    organizationId: orgId,
    provider: "TUYA",
    externalDeviceId,
  },
  data: {
    deviceProfile,
    tuyaFunctions: functions as any,
    profileSource: "AUTO_CAPABILITIES",
    profileDetectedAt: new Date(),
  },
});

console.log("[org.tuya.devices] persist result", {
  externalDeviceId,
  persistResult,
});

        return {
          externalDeviceId,
          deviceName: resolvedName,
          deviceCategory: resolvedCategory,
          deviceProfile,
          functions,
          online: Boolean(d?.online ?? false),
          provider: "TUYA",

          id: externalDeviceId,
          name: resolvedName,
          category: resolvedCategory,
          isAssigned: Boolean(assignment),
          assignment,
        };
      })
    );

    return res.json({
      ok: true,
      organizationId: orgId,
      uid: linkedUid,
      count: items.length,
      items,
    });
  } catch (err: any) {
    console.error("[org.tuya.devices] error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

/**
 * POST /api/org/tuya/map-device
 */
router.post("/api/org/tuya/map-device", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();
    const propertyId = String(req.body?.propertyId ?? "").trim();
    const externalId = String(req.body?.externalId ?? "").trim();
    const name = String(req.body?.name ?? "").trim();
    const type = String(req.body?.type ?? "").trim().toUpperCase();
    const metadata = req.body?.metadata ?? null;

    if (!orgId) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHENTICATED",
      });
    }

    if (!propertyId) {
      return res.status(400).json({
        ok: false,
        error: "PROPERTY_ID_REQUIRED",
      });
    }

    if (!externalId) {
      return res.status(400).json({
        ok: false,
        error: "EXTERNAL_ID_REQUIRED",
      });
    }

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "NAME_REQUIRED",
      });
    }

    if (!type) {
      return res.status(400).json({
        ok: false,
        error: "TYPE_REQUIRED",
      });
    }

    const property = await prisma.property.findFirst({
      where: {
        id: propertyId,
        organizationId: orgId,
      },
    });

    if (!property) {
      return res.status(404).json({
        ok: false,
        error: "PROPERTY_NOT_FOUND",
      });
    }

    const existing = await prisma.propertyDevice.findFirst({
      where: {
        organizationId: orgId,
        provider: "TUYA",
        externalId,
      },
    });

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: "DEVICE_ALREADY_MAPPED",
        propertyDevice: existing,
      });
    }

    const propertyDevice = await prisma.propertyDevice.create({
      data: {
        organizationId: orgId,
        propertyId,
        name,
        type,
        provider: "TUYA",
        externalId,
        isActive: true,
        metadata,
      },
    });

    return res.json({
      ok: true,
      propertyDevice,
    });
  } catch (err: any) {
    console.error("[org.tuya.map-device] error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

/**
 * POST /api/org/tuya/command
 */
router.post("/api/org/tuya/command", async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = String(req.user?.orgId ?? "").trim();
    const deviceId = String(req.body?.deviceId ?? "").trim();
    const commands = req.body?.commands;

    if (!orgId) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHENTICATED",
      });
    }

    if (!deviceId) {
      return res.status(400).json({
        ok: false,
        error: "DEVICE_ID_REQUIRED",
      });
    }

    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "COMMANDS_REQUIRED",
      });
    }

    const device = await prisma.propertyDevice.findFirst({
      where: {
        id: deviceId,
        organizationId: orgId,
        provider: "TUYA",
        isActive: true,
      },
    });

    if (!device || !device.externalId) {
      return res.status(404).json({
        ok: false,
        error: "DEVICE_NOT_FOUND",
      });
    }

    const accessToken = await getValidTuyaAccessToken();

    const resp = await tuyaRequest({
      method: "POST",
      path: `/v1.0/iot-03/devices/${device.externalId}/commands`,
      accessToken,
      body: {
        commands,
      },
    });

    if (!resp.success) {
      return res.status(500).json({
        ok: false,
        error: resp.msg ?? resp.code ?? "COMMAND_FAILED",
        tuya: {
          code: resp.code,
          msg: resp.msg,
          tid: resp.tid,
          t: resp.t,
        },
      });
    }

    return res.json({
      ok: true,
      deviceId: device.id,
      externalId: device.externalId,
      result: resp.result,
    });
  } catch (err: any) {
    console.error("[org.tuya.command] error", err);

    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

export default router;