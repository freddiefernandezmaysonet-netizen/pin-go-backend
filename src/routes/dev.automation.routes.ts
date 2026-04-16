import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { runAutomation } from "../automation/automation.executor.ts";

const prisma = new PrismaClient();
const router = Router();

type AuthedRequest = Request & {
  user?: {
    orgId?: string;
  };
};

router.use(requireAuth);

// 🔥 RUN MANUAL (DEV ONLY)
router.post("/api/dev/automation/run", async (req: AuthedRequest, res: Response) => {
  try {
    const organizationId = String(req.user?.orgId ?? "").trim();
    const propertyId = String(req.body?.propertyId ?? "").trim();
    const trigger = String(req.body?.trigger ?? "").trim().toUpperCase();

    if (!organizationId) {
      return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    }

    if (!propertyId) {
      return res.status(400).json({ ok: false, error: "PROPERTY_ID_REQUIRED" });
    }

    if (!trigger) {
      return res.status(400).json({ ok: false, error: "TRIGGER_REQUIRED" });
    }

    const property = await prisma.property.findFirst({
      where: { id: propertyId, organizationId },
      select: { id: true, name: true },
    });

    if (!property) {
      return res.status(404).json({
        ok: false,
        error: "PROPERTY_NOT_FOUND",
      });
    }

    const result = await runAutomation({
      organizationId,
      propertyId,
      trigger,
    });

    return res.json({
      ...result,
      property,
    });
  } catch (err: any) {
    console.error("[automation.run] error", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

// 🔥 HISTORY (PRODUCTION-SAFE)
router.get("/api/automation/history", async (req: AuthedRequest, res: Response) => {
  try {
    const organizationId = String(req.user?.orgId ?? "").trim();
    const propertyId = String(req.query?.propertyId ?? "").trim();
    const takeRaw = Number(req.query?.take);

    const take =
      Number.isFinite(takeRaw) && takeRaw > 0
        ? Math.min(Math.floor(takeRaw), 200)
        : 50;

    if (!organizationId) {
      return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    }

    let propertyFilter: string | undefined;

    if (propertyId) {
      const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "PROPERTY_NOT_FOUND",
        });
      }

      propertyFilter = property.id;
    }

    const items = await prisma.automationExecutionLog.findMany({
      where: {
        organizationId,
        ...(propertyFilter ? { propertyId: propertyFilter } : {}),
      },
      orderBy: { executedAt: "desc" },
      take,
    });

    const propertyIds = Array.from(new Set(items.map((i) => i.propertyId)));

    const reservationIds = Array.from(
      new Set(items.map((i) => i.reservationId).filter(Boolean))
    ) as string[];

    const [properties, reservations] = await Promise.all([
      propertyIds.length > 0
        ? prisma.property.findMany({
            where: {
              organizationId,
              id: { in: propertyIds },
            },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      reservationIds.length > 0
        ? prisma.reservation.findMany({
            where: { id: { in: reservationIds } },
            select: {
              id: true,
              guestName: true,
              roomName: true,
              checkIn: true,
              checkOut: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const propertyMap = new Map(properties.map((p) => [p.id, p]));
    const reservationMap = new Map(reservations.map((r) => [r.id, r]));

    return res.json({
      ok: true,
      count: items.length,
      items: items.map((item) => ({
        id: item.id,
        propertyId: item.propertyId,
        reservationId: item.reservationId,

        property: propertyMap.get(item.propertyId) ?? null,
        reservation: item.reservationId
          ? reservationMap.get(item.reservationId) ?? null
          : null,

        trigger: item.trigger,
        source: item.source,

        deviceName: item.deviceName,
        deviceCategory: item.deviceCategory,
        externalId: item.externalId,

        action: item.action,
        value: item.value,

        status: item.status,
        errorMessage: item.errorMessage,

        executedAt: item.executedAt,
      })),
    });
  } catch (err: any) {
    console.error("[automation.history] error", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message ?? err),
    });
  }
});

export default router;