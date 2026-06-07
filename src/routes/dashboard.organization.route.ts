import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardOrganizationRouter = Router();

function normalizeSlug(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

dashboardOrganizationRouter.get(
  "/api/dashboard/organization",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;

      const organization = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          id: true,
          name: true,
          slug: true,
          publicBookingEnabled: true,
          updatedAt: true,
        },
      });

      if (!organization) {
        return res.status(404).json({
          error: "ORGANIZATION_NOT_FOUND",
        });
      }

      return res.json({
        organization,
      });
    } catch (e) {
      console.error("[dashboard/organization:get] ERROR", e);
      return res.status(500).json({
        error: "ORGANIZATION_FETCH_FAILED",
      });
    }
  }
);

dashboardOrganizationRouter.patch(
  "/api/dashboard/organization",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;

      const nameRaw = req.body?.name;
      const slugRaw = req.body?.slug;
      const publicBookingEnabledRaw = req.body?.publicBookingEnabled;

      const data: Prisma.OrganizationUpdateInput = {};

      if (nameRaw !== undefined) {
        const name = String(nameRaw ?? "").trim();

        if (!name) {
          return res.status(400).json({
            error: "ORGANIZATION_NAME_REQUIRED",
          });
        }

        data.name = name;
      }

      if (slugRaw !== undefined) {
        const slug = normalizeSlug(slugRaw);

        if (!slug) {
          return res.status(400).json({
            error: "ORGANIZATION_SLUG_REQUIRED",
          });
        }

        if (slug.length < 3) {
          return res.status(400).json({
            error: "ORGANIZATION_SLUG_TOO_SHORT",
          });
        }

        if (slug.length > 60) {
          return res.status(400).json({
            error: "ORGANIZATION_SLUG_TOO_LONG",
          });
        }

        const existing = await prisma.organization.findFirst({
          where: {
            slug,
            NOT: {
              id: orgId,
            },
          },
          select: {
            id: true,
          },
        });

        if (existing) {
          return res.status(409).json({
            error: "ORGANIZATION_SLUG_TAKEN",
          });
        }

        data.slug = slug;
      }

      if (publicBookingEnabledRaw !== undefined) {
        data.publicBookingEnabled = Boolean(publicBookingEnabledRaw);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          error: "NO_ORGANIZATION_FIELDS_TO_UPDATE",
        });
      }

      const organization = await prisma.organization.update({
        where: { id: orgId },
        data,
        select: {
          id: true,
          name: true,
          slug: true,
          publicBookingEnabled: true,
          updatedAt: true,
        },
      });

      return res.json({
        organization,
      });
    } catch (e) {
      console.error("[dashboard/organization:patch] ERROR", e);
      return res.status(500).json({
        error: "ORGANIZATION_UPDATE_FAILED",
      });
    }
  }
);