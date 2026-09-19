import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import {
  getEditablePropertyGuestKnowledge,
  upsertPropertyGuestKnowledge,
} from "../pin-ai/property-guest-knowledge.service.js";

export function buildDashboardPropertyGuestKnowledgeRouter(
  prisma: PrismaClient,
) {
  const router = Router();

  router.use(requireAuth);

  router.get(
    "/api/dashboard/properties/:propertyId/pin-ai-knowledge",
    async (req, res) => {
      try {
        const user = (req as any).user;
        const organizationId = String(user.orgId);
        const propertyId = String(req.params.propertyId);

        const item = await getEditablePropertyGuestKnowledge({
          prisma: prisma as any,
          organizationId,
          propertyId,
        });

        return res.json({
          ok: true,
          item,
        });
      } catch (error: any) {
        if (
          error instanceof Error &&
          error.message === "PROPERTY_GUEST_KNOWLEDGE_PROPERTY_NOT_FOUND"
        ) {
          return res.status(404).json({
            ok: false,
            error: "Property not found",
          });
        }

        console.error("GET property Pin AI knowledge error", {
          name: error instanceof Error ? error.name : "UnknownError",
        });

        return res.status(500).json({
          ok: false,
          error: "Failed to load Pin AI property knowledge",
        });
      }
    },
  );

  router.patch(
    "/api/dashboard/properties/:propertyId/pin-ai-knowledge",
    async (req, res) => {
      try {
        const user = (req as any).user;
        const organizationId = String(user.orgId);
        const propertyId = String(req.params.propertyId);

        const item = await upsertPropertyGuestKnowledge({
          prisma: prisma as any,
          organizationId,
          propertyId,
          input: req.body ?? {},
        });

        return res.json({
          ok: true,
          item,
        });
      } catch (error: any) {
        if (
          error instanceof Error &&
          error.message === "PROPERTY_GUEST_KNOWLEDGE_PROPERTY_NOT_FOUND"
        ) {
          return res.status(404).json({
            ok: false,
            error: "Property not found",
          });
        }

        if (
          error instanceof Error &&
          error.message.startsWith("PROPERTY_GUEST_KNOWLEDGE_")
        ) {
          return res.status(400).json({
            ok: false,
            error: error.message,
          });
        }

        console.error("PATCH property Pin AI knowledge error", {
          name: error instanceof Error ? error.name : "UnknownError",
        });

        return res.status(500).json({
          ok: false,
          error: "Failed to update Pin AI property knowledge",
        });
      }
    },
  );

  return router;
}
