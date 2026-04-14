import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";
import { requireOrg } from "../middleware/requireOrg";

const prisma = new PrismaClient();
const router = Router();

// =======================
// GET messages
// =======================
router.get("/messages", requireOrg(prisma), async (req, res) => {
  try {
    const orgId = String((req as any).orgId ?? "").trim();
    const rawStatus = String(req.query.status ?? "").trim();
    const rawPropertyId = String(req.query.propertyId ?? "").trim();

    const status = rawStatus ? rawStatus.toUpperCase() : "";
    const propertyId = rawPropertyId || "";

    const items = await prisma.messageLog.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          // ✅ camino nuevo: logs multi-tenant directos
          {
            organizationId: orgId,
            ...(propertyId ? { propertyId } : {}),
          },

          // ✅ fallback seguro: logs viejos sin organizationId/propertyId
          {
            organizationId: null,
            ...(propertyId ? { propertyId: null } : {}),
            accessGrant: {
              reservation: {
                property: {
                  organizationId: orgId,
                  ...(propertyId ? { id: propertyId } : {}),
                },
              },
            },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        accessGrant: {
          select: {
            id: true,
            reservation: {
              select: {
                id: true,
                propertyId: true,
                property: {
                  select: {
                    id: true,
                    name: true,
                    organizationId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const propertyIds = Array.from(
      new Set(
        items
          .map((item) => item.propertyId ?? item.accessGrant?.reservation?.propertyId ?? null)
          .filter((v): v is string => Boolean(v))
      )
    );

    const properties =
      propertyIds.length > 0
        ? await prisma.property.findMany({
            where: {
              id: { in: propertyIds },
              organizationId: orgId,
            },
            select: {
              id: true,
              name: true,
            },
          })
        : [];

    const propertyNameById = new Map(properties.map((p) => [p.id, p.name]));

    res.json({
      items: items.map((item) => {
        const resolvedPropertyId =
          item.propertyId ?? item.accessGrant?.reservation?.propertyId ?? null;

        const resolvedPropertyName =
          (resolvedPropertyId ? propertyNameById.get(resolvedPropertyId) : null) ??
          item.accessGrant?.reservation?.property?.name ??
          null;

        return {
          id: item.id,
          to: item.to,
          body: item.body,
          status: item.status,
          retryCount: item.retryCount,
          createdAt: item.createdAt,
          reservationId: item.reservationId ?? item.accessGrant?.reservation?.id ?? null,
          propertyId: resolvedPropertyId,
          propertyName: resolvedPropertyName,
          organizationId:
            item.organizationId ??
            item.accessGrant?.reservation?.property?.organizationId ??
            null,
        };
      }),
    });
  } catch (e) {
    console.error("[messages] fetch error", e);
    res.status(500).json({ ok: false });
  }
});

// =======================
// POST retry
// =======================
router.post("/messages/:id/retry", requireOrg(prisma), async (req, res) => {
  try {
    const orgId = String((req as any).orgId ?? "").trim();
    const { id } = req.params;

    const msg = await prisma.messageLog.findFirst({
      where: {
        id,
        OR: [
          // ✅ camino nuevo
          { organizationId: orgId },

          // ✅ fallback seguro para logs viejos
          {
            organizationId: null,
            accessGrant: {
              reservation: {
                property: {
                  organizationId: orgId,
                },
              },
            },
          },
        ],
      },
      include: {
        accessGrant: {
          select: {
            reservation: {
              select: {
                property: {
                  select: {
                    organizationId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!msg) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    if (!msg.to || !msg.body) {
      return res.status(400).json({ ok: false, error: "invalid_message" });
    }

    try {
      const sent = await sendSms(msg.to, msg.body);

      await prisma.messageLog.update({
        where: { id: msg.id },
        data: {
          status: "SENT",
          providerMessageId: (sent as any)?.sid ?? null,
          retryCount: { increment: 1 },
          error: null,
        },
      });

      return res.json({ ok: true });
    } catch (e: any) {
      await prisma.messageLog.update({
        where: { id: msg.id },
        data: {
          status: "FAILED",
          retryCount: { increment: 1 },
          error: e?.message ?? "retry_failed",
        },
      });

      return res.status(500).json({ ok: false, error: "retry_failed" });
    }
  } catch (e) {
    console.error("[messages retry] error", e);
    res.status(500).json({ ok: false });
  }
});

export default router;