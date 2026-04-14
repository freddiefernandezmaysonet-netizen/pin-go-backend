import { Router, type Request, type Response } from "express";
import { requireTuyaConnected } from "../middleware/requireTuyaEntitlement";

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

  const fromQuery = normalizeString((req as any).query?.organizationId);
  if (fromQuery) return fromQuery;

  return null;
}

/**
 * 🔌 Este método intenta ser compatible con tu implementación actual de Tuya
 * sin asumir nombres exactos de tablas.
 */
async function loadTuyaDevices(prisma: PrismaLike, orgId: string) {
  const db = prisma as any;

  // 🔹 intento 1: tabla dedicada tuyaDevice
  if (db?.tuyaDevice?.findMany) {
    try {
      return await db.tuyaDevice.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: "desc" },
      });
    } catch {}
  }

  // 🔹 intento 2: tabla genérica device
  if (db?.device?.findMany) {
    try {
      return await db.device.findMany({
        where: {
          organizationId: orgId,
          OR: [
            { provider: "TUYA" },
            { integration: "TUYA" },
          ],
        },
        orderBy: { createdAt: "desc" },
      });
    } catch {}
  }

  // 🔹 intento 3: devices relacionados a property
  if (db?.property?.findMany) {
    try {
      const props = await db.property.findMany({
        where: { organizationId: orgId },
        include: {
          devices: true,
        },
      });

      return props.flatMap((p: any) =>
        (p.devices ?? []).map((d: any) => ({
          ...d,
          propertyName: p.name,
        }))
      );
    } catch {}
  }

  return [];
}

function normalizeDevice(device: any) {
  return {
    id: device.id ?? device.deviceId ?? null,
    name: device.name ?? device.deviceName ?? "Device",
    deviceId: device.deviceId ?? device.externalId ?? device.id ?? null,
    productName: device.productName ?? device.product ?? null,
    category: device.category ?? device.type ?? null,
    online:
      device.online ??
      device.isOnline ??
      device.status === "ONLINE" ??
      null,
    enabled:
      device.enabled ??
      device.active ??
      device.status === "ENABLED" ??
      null,
    propertyName:
      device.propertyName ??
      device.property?.name ??
      null,
    roomName: device.roomName ?? null,
    lastSeenAt:
      device.lastSeenAt ??
      device.updatedAt ??
      null,
  };
}

export function buildTuyaDevicesRouter(prisma: PrismaLike) {
  const router = Router();

  /**
   * GET /api/org/tuya/devices
   *
   * 🔒 Requiere:
   * - entitlement activo
   * - tuya conectado
   */
  router.get(
    "/",
    requireTuyaConnected(prisma),
    async (req: Request, res: Response) => {
      try {
        const orgId = resolveOrgId(req);

        if (!orgId) {
          return res.status(400).json({
            ok: false,
            error: "ORGANIZATION_ID_REQUIRED",
          });
        }

        const rawDevices = await loadTuyaDevices(prisma, orgId);
        const items = (rawDevices ?? []).map(normalizeDevice);

        return res.json({
          ok: true,
          total: items.length,
          items,
        });
      } catch (error: any) {
        return res.status(500).json({
          ok: false,
          error: "TUYA_DEVICES_FAILED",
          message:
            error?.message ||
            "Unexpected error while loading Tuya devices",
        });
      }
    }
  );

  return router;
}

export default buildTuyaDevicesRouter;