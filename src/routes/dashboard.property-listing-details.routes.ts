import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import {
  normalizePropertyListingDetailsInput,
  PropertyListingDetailsValidationError,
} from "../services/property-listing-details.service";

const listingDetailsInclude = {
  sleepingAreas: {
    orderBy: { sortOrder: "asc" as const },
    include: { beds: { orderBy: { createdAt: "asc" as const } } },
  },
  sharedSpaces: { orderBy: { sortOrder: "asc" as const } },
  safetyConsiderations: { orderBy: { sortOrder: "asc" as const } },
  additionalConsiderations: { orderBy: { sortOrder: "asc" as const } },
};

export function buildDashboardPropertyListingDetailsRouter(prisma: PrismaClient) {
  const router = Router();

  router.get(
    "/api/dashboard/properties/:id/listing-details",
    requireAuth,
    async (req, res) => {
      try {
        const orgId = String((req as any).user?.orgId ?? "");
        const propertyId = String(req.params.id ?? "");

        const property = await prisma.property.findFirst({
          where: { id: propertyId, organizationId: orgId, status: { not: "ARCHIVED" } },
          select: { id: true, maxGuests: true },
        });

        if (!property) {
          return res.status(404).json({ ok: false, error: "Property not found" });
        }

        const listingDetails = await prisma.propertyListingDetails.findUnique({
          where: { propertyId },
          include: listingDetailsInclude,
        });

        return res.json({
          ok: true,
          maxGuests: property.maxGuests,
          listingDetails,
        });
      } catch (error: any) {
        console.error("[listing-details GET error]", error);
        return res.status(500).json({
          ok: false,
          error: error?.message ?? "Failed to load property listing details",
        });
      }
    }
  );

  router.put(
    "/api/dashboard/properties/:id/listing-details",
    requireAuth,
    async (req, res) => {
      try {
        const orgId = String((req as any).user?.orgId ?? "");
        const propertyId = String(req.params.id ?? "");

        const property = await prisma.property.findFirst({
          where: { id: propertyId, organizationId: orgId, status: { not: "ARCHIVED" } },
          select: { id: true, maxGuests: true },
        });

        if (!property) {
          return res.status(404).json({ ok: false, error: "Property not found" });
        }

        const input = normalizePropertyListingDetailsInput(req.body);
        const {
          sleepingAreas,
          sharedSpaces,
          safetyConsiderations,
          additionalConsiderations,
          ...scalar
        } = input;

        const listingDetails = await prisma.$transaction(async (tx) => {
          const details = await tx.propertyListingDetails.upsert({
            where: { propertyId },
            create: {
              propertyId,
              ...scalar,
              version: 1,
            },
            update: {
              ...scalar,
              version: { increment: 1 },
            },
          });

          await tx.propertyListingSleepingArea.deleteMany({
            where: { listingDetailsId: details.id },
          });
          await tx.propertyListingSharedSpace.deleteMany({
            where: { listingDetailsId: details.id },
          });
          await tx.propertyListingSafetyConsideration.deleteMany({
            where: { listingDetailsId: details.id },
          });
          await tx.propertyListingAdditionalConsideration.deleteMany({
            where: { listingDetailsId: details.id },
          });

          for (const area of sleepingAreas) {
            await tx.propertyListingSleepingArea.create({
              data: {
                listingDetailsId: details.id,
                kind: area.kind,
                nameEn: area.nameEn,
                nameEs: area.nameEs,
                sortOrder: area.sortOrder,
                beds: {
                  create: area.beds.map((bed) => ({
                    type: bed.type,
                    quantity: bed.quantity,
                  })),
                },
              },
            });
          }

          if (sharedSpaces.length > 0) {
            await tx.propertyListingSharedSpace.createMany({
              data: sharedSpaces.map((space) => ({
                listingDetailsId: details.id,
                ...space,
              })),
            });
          }

          if (safetyConsiderations.length > 0) {
            await tx.propertyListingSafetyConsideration.createMany({
              data: safetyConsiderations.map((item) => ({
                listingDetailsId: details.id,
                ...item,
              })),
            });
          }

          if (additionalConsiderations.length > 0) {
            await tx.propertyListingAdditionalConsideration.createMany({
              data: additionalConsiderations.map((item) => ({
                listingDetailsId: details.id,
                ...item,
              })),
            });
          }

          return tx.propertyListingDetails.findUniqueOrThrow({
            where: { propertyId },
            include: listingDetailsInclude,
          });
        });

        return res.json({
          ok: true,
          maxGuests: property.maxGuests,
          listingDetails,
        });
      } catch (error: any) {
        if (error instanceof PropertyListingDetailsValidationError) {
          return res.status(400).json({
            ok: false,
            error: error.code,
            issues: error.issues,
          });
        }

        console.error("[listing-details PUT error]", error);
        return res.status(500).json({
          ok: false,
          error: error?.message ?? "Failed to save property listing details",
        });
      }
    }
  );

  return router;
}
