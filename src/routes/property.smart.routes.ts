import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

type AuthedRequest = Request & {
  user?: {
    orgId?: string;
    id?: string;
  };
};

export function buildPropertySmartRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * GET smart status for property
   */
  router.get("/:id/smart-status", async (req: AuthedRequest, res: Response) => {
    try {
      const propertyId = String(req.params.id ?? "").trim();
      const orgId = String(req.user?.orgId ?? "").trim();

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "UNAUTHENTICATED",
        });
      }

      const property = await prisma.property.findFirst({
        where: {
          id: propertyId,
          organizationId: orgId,
        },
        select: {
          id: true,
          name: true,
          isSmartEnabled: true,
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "PROPERTY_NOT_FOUND",
        });
      }

      const subscription = await prisma.subscription.findFirst({
        where: {
          organizationId: orgId,
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          entitledSmartProperties: true,
          status: true,
        },
      });

      const smartUsed = await prisma.property.count({
        where: {
          organizationId: orgId,
          isSmartEnabled: true,
        },
      });

      const isActive =
        subscription &&
        (subscription.status === "ACTIVE" ||
          subscription.status === "TRIALING");

      const smartLimit = isActive
        ? subscription?.entitledSmartProperties ?? 0
        : 0;

      let state: "locked" | "available" | "connected" = "locked";

      if (property.isSmartEnabled) {
        state = "connected";
      } else if (smartUsed < smartLimit) {
        state = "available";
      } else {
        state = "locked";
      }

      return res.json({
        ok: true,
        propertyId,
        state,
        smartUsed,
        smartLimit,
        isSmartEnabled: property.isSmartEnabled,
      });
    } catch (err: any) {
      console.error("[property.smart.get] error", err);

      return res.status(500).json({
        ok: false,
        error: "FAILED_TO_LOAD_SMART_STATUS",
      });
    }
  });

  /**
   * ENABLE SMART for property
   */
  router.post("/:id/enable-smart", async (req: AuthedRequest, res: Response) => {
    try {
      const propertyId = String(req.params.id ?? "").trim();
      const orgId = String(req.user?.orgId ?? "").trim();

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "UNAUTHENTICATED",
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

      if (property.isSmartEnabled) {
        return res.json({
          ok: true,
          alreadyEnabled: true,
        });
      }

      const subscription = await prisma.subscription.findFirst({
        where: {
          organizationId: orgId,
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          entitledSmartProperties: true,
          status: true,
        },
      });

      const isActive =
        subscription &&
        (subscription.status === "ACTIVE" ||
          subscription.status === "TRIALING");

      const smartLimit = isActive
        ? subscription?.entitledSmartProperties ?? 0
        : 0;

      if (smartLimit < 1) {
        return res.status(403).json({
          ok: false,
          error: "SMART_PROPERTY_ENTITLEMENT_REQUIRED",
          smartLimit,
        });
      }

      const smartUsed = await prisma.property.count({
        where: {
          organizationId: orgId,
          isSmartEnabled: true,
        },
      });

      if (smartUsed >= smartLimit) {
        return res.status(403).json({
          ok: false,
          error: "SMART_CAPACITY_EXCEEDED",
          smartUsed,
          smartLimit,
        });
      }

      await prisma.property.update({
        where: { id: propertyId },
        data: {
          isSmartEnabled: true,
        },
      });

      return res.json({
        ok: true,
        enabled: true,
      });
    } catch (err: any) {
      console.error("[property.smart.enable] error", err);

      return res.status(500).json({
        ok: false,
        error: "FAILED_TO_ENABLE_SMART",
      });
    }
  });

  /**
   * DISABLE SMART for property
   */
  router.post("/:id/disable-smart", async (req: AuthedRequest, res: Response) => {
    try {
      const propertyId = String(req.params.id ?? "").trim();
      const orgId = String(req.user?.orgId ?? "").trim();

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "UNAUTHENTICATED",
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

      if (!property.isSmartEnabled) {
        return res.json({
          ok: true,
          alreadyDisabled: true,
        });
      }

      await prisma.property.update({
        where: { id: propertyId },
        data: {
          isSmartEnabled: false,
        },
      });

      return res.json({
        ok: true,
        disabled: true,
      });
    } catch (err: any) {
      console.error("[property.smart.disable] error", err);

      return res.status(500).json({
        ok: false,
        error: "FAILED_TO_DISABLE_SMART",
      });
    }
  });

  return router;
}