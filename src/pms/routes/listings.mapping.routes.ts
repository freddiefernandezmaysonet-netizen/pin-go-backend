import type { PrismaClient } from "@prisma/client";
import { Router } from "express";

import { requireAuth } from "../../middleware/requireAuth";

type ListingsMappingRouterOptions = {
  nodeEnv?: string;
};

function organizationIdFromRequest(req: unknown): string {
  return String((req as { user?: { orgId?: unknown } }).user?.orgId ?? "").trim();
}

export function buildListingsMappingRouter(
  prisma: PrismaClient,
  options: ListingsMappingRouterOptions = {}
) {
  const router = Router();
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;

  router.use(requireAuth);

  router.get("/pending", async (req, res) => {
    try {
      const organizationId = organizationIdFromRequest(req);
      const connectionId = String(req.query.connectionId ?? "").trim();

      if (!connectionId) {
        return res.status(400).json({ ok: false, error: "MISSING_CONNECTION_ID" });
      }

      const connection = await prisma.pmsConnection.findFirst({
        where: { id: connectionId, organizationId },
        select: { id: true },
      });

      if (!connection) {
        return res.status(404).json({ ok: false, error: "PMS_CONNECTION_NOT_FOUND" });
      }

      const items = await prisma.pmsListing.findMany({
        where: { connectionId: connection.id, propertyId: null },
        select: {
          id: true,
          externalListingId: true,
          name: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return res.json({ ok: true, items });
    } catch (error) {
      console.error("[pms.listings.pending] failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return res.status(500).json({ ok: false, error: "PMS_LISTINGS_LOOKUP_FAILED" });
    }
  });

  router.post("/:pmsListingId/map", async (req, res) => {
    try {
      const organizationId = organizationIdFromRequest(req);
      const pmsListingId = String(req.params.pmsListingId ?? "").trim();
      const propertyId = String(req.body?.propertyId ?? "").trim();

      if (!propertyId) {
        return res.status(400).json({ ok: false, error: "MISSING_PROPERTY_ID" });
      }

      const [listing, property] = await Promise.all([
        prisma.pmsListing.findFirst({
          where: {
            id: pmsListingId,
            connection: { organizationId },
          },
          select: { id: true, connectionId: true },
        }),
        prisma.property.findFirst({
          where: { id: propertyId, organizationId },
          select: { id: true },
        }),
      ]);

      if (!listing || !property) {
        return res.status(404).json({ ok: false, error: "PMS_MAPPING_TARGET_NOT_FOUND" });
      }

      const update = await prisma.pmsListing.updateMany({
        where: { id: listing.id, connectionId: listing.connectionId },
        data: { propertyId: property.id },
      });

      if (update.count !== 1) {
        return res.status(409).json({ ok: false, error: "PMS_MAPPING_CONFLICT" });
      }

      const mappedListing = await prisma.pmsListing.findUnique({
        where: { id: listing.id },
      });

      return res.json({ ok: true, listing: mappedListing });
    } catch (error) {
      console.error("[pms.listings.map] failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return res.status(500).json({ ok: false, error: "PMS_LISTING_MAPPING_FAILED" });
    }
  });

  router.post("/retry-failed/:connectionId", async (req, res) => {
    try {
      const organizationId = organizationIdFromRequest(req);
      const connectionId = String(req.params.connectionId ?? "").trim();
      const connection = await prisma.pmsConnection.findFirst({
        where: { id: connectionId, organizationId },
        select: { id: true },
      });

      if (!connection) {
        return res.status(404).json({ ok: false, error: "PMS_CONNECTION_NOT_FOUND" });
      }

      const failedEvents = await prisma.webhookEventIngest.findMany({
        where: { connectionId: connection.id, status: "FAILED" },
        select: { id: true },
        take: 50,
      });

      const eventIds = failedEvents.map((event) => event.id);
      if (eventIds.length > 0) {
        await prisma.webhookEventIngest.updateMany({
          where: { connectionId: connection.id, id: { in: eventIds } },
          data: { status: "PENDING" },
        });
      }

      return res.json({ ok: true, retried: eventIds.length });
    } catch (error) {
      console.error("[pms.listings.retry] failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return res.status(500).json({ ok: false, error: "PMS_LISTING_RETRY_FAILED" });
    }
  });

  if (nodeEnv !== "production") {
    router.post("/dev-create", async (req, res) => {
      try {
        const organizationId = organizationIdFromRequest(req);
        const connectionId = String(req.body?.connectionId ?? "").trim();
        const externalListingId = String(req.body?.externalListingId ?? "").trim();

        if (!connectionId) {
          return res.status(400).json({ ok: false, error: "MISSING_CONNECTION_ID" });
        }
        if (!externalListingId) {
          return res.status(400).json({ ok: false, error: "MISSING_EXTERNAL_LISTING_ID" });
        }

        const connection = await prisma.pmsConnection.findFirst({
          where: { id: connectionId, organizationId },
          select: { id: true },
        });

        if (!connection) {
          return res.status(404).json({ ok: false, error: "PMS_CONNECTION_NOT_FOUND" });
        }

        const listing = await prisma.pmsListing.create({
          data: {
            connectionId: connection.id,
            externalListingId,
            name: String(req.body?.name ?? `Listing ${externalListingId}`),
          },
        });

        return res.json({ ok: true, listing });
      } catch (error) {
        console.error("[pms.listings.dev-create] failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
        return res.status(500).json({ ok: false, error: "PMS_LISTING_CREATE_FAILED" });
      }
    });
  }

  return router;
}
