import { Router } from "express";
import { PrismaClient, AccessMethod, AccessGrantType } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { activateGrant } from "../services/access.service";

const prisma = new PrismaClient();
export const adminDemoRouter = Router();

function assertPlatformAdmin(req: any, res: any) {
  const user = req.user;
  if (!user || user.role !== "PLATFORM_ADMIN") {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }
  return true;
}

adminDemoRouter.post(
  "/api/internal/admin/demo/run",
  requireAuth,
  async (req, res) => {
    try {
      if (!assertPlatformAdmin(req, res)) return;

      const user = req.user;
      const orgId = user.orgId as string;

      // 🔍 Buscar propiedad DEMO
      const property = await prisma.property.findFirst({
        where: {
          organizationId: orgId,
          name: { contains: "Demo" },
        },
        include: {
          locks: true,
        },
      });

      if (!property || !property.locks.length) {
        return res.status(400).json({
          ok: false,
          error: "No demo property or lock found",
        });
      }

      const lock = property.locks[0];

      // ⏱ Ventana DEMO
      const now = new Date();
      const startsAt = new Date(now.getTime() + 2 * 60 * 1000); // +2 min
      const endsAt = new Date(now.getTime() + 60 * 60 * 1000); // +1h

      // 🧾 Crear reservation DEMO
      const reservation = await prisma.reservation.create({
        data: {
          propertyId: property.id,
          guestName: "Pin&Go Demo Guest",
          guestEmail: "demo@pingo.com",
          status: "ACTIVE",
          source: "DEMO",
          checkIn: startsAt,
          checkOut: endsAt,
          externalId: `DEMO:${Date.now()}`,
        },
      });

      // 🔐 Crear accessGrant
      const grant = await prisma.accessGrant.create({
        data: {
          organizationId: orgId,
          reservationId: reservation.id,
          propertyId: property.id,
          lockId: lock.id,
          method: AccessMethod.PASSCODE_TIMEBOUND,
          type: AccessGrantType.GUEST,
          status: "ACTIVE",
          startsAt,
          endsAt,
        },
        include: {
          lock: true,
        },
      });

    const activatedGrant = await activateGrant(prisma, grant.id);
     
     return res.json({
  ok: true,
  data: {
    property: property.name,
    reservationId: reservation.id,
    grantId: grant.id,
    startsAt,
    endsAt,
    activatedGrant,
  },
});

    } catch (error) {
      console.error("[DEMO_RUN_ERROR]", error);
      return res.status(500).json({
        ok: false,
        error: "Demo failed",
      });
    }
  }
);