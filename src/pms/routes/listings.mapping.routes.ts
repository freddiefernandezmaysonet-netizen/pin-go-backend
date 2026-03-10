import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
export const listingsMappingRouter = Router();

/**
 * GET pending listings (sin property asignada)
 * GET /api/pms/listings/pending?connectionId=...
 */
listingsMappingRouter.get("/pending", async (req, res) => {
  try {
    const connectionId = String(req.query.connectionId || "");
    if (!connectionId) {
      return res.status(400).json({ ok: false, error: "MISSING_CONNECTION_ID" });
    }

    const items = await prisma.pmsListing.findMany({
      where: {
        connectionId,
        propertyId: null,
      },
      select: {
        id: true,
        externalListingId: true,
        name: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ ok: true, items });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Mapear listing → property
 * POST /api/pms/listings/:pmsListingId/map
 */
listingsMappingRouter.post("/:pmsListingId/map", async (req, res) => {
  try {
    const { pmsListingId } = req.params;
    const { propertyId } = req.body;

    if (!propertyId) {
      return res.status(400).json({ ok: false, error: "MISSING_PROPERTY_ID" });
    }

    const updated = await prisma.pmsListing.update({
      where: { id: pmsListingId },
      data: { propertyId },
    });

    res.json({ ok: true, listing: updated });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Reintentar webhooks fallidos después del mapping
 * POST /api/pms/listings/retry-failed/:connectionId
 */
listingsMappingRouter.post("/retry-failed/:connectionId", async (req, res) => {
  try {
    const { connectionId } = req.params;

    const failedEvents = await prisma.webhookEventIngest.findMany({
      where: {
        connectionId,
        status: "FAILED",
      },
      select: { id: true },
      take: 50,
    });

    await prisma.webhookEventIngest.updateMany({
      where: {
        id: { in: failedEvents.map((e) => e.id) },
      },
      data: {
        status: "PENDING",
      },
    });

    res.json({
      ok: true,
      retried: failedEvents.length,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * DEV ONLY
 * Crear listing PMS manual para pruebas
 * POST /api/pms/listings/dev-create
 */
listingsMappingRouter.post("/dev-create", async (req, res) => {
  try {
    const { connectionId, externalListingId, name } = req.body ?? {};

    if (!connectionId) {
      return res.status(400).json({ ok: false, error: "MISSING_CONNECTION_ID" });
    }

    if (!externalListingId) {
      return res.status(400).json({ ok: false, error: "MISSING_EXTERNAL_LISTING_ID" });
    }

    const listing = await prisma.pmsListing.create({
      data: {
        connectionId: String(connectionId),
        externalListingId: String(externalListingId),
        name: String(name ?? `Listing ${externalListingId}`),
      },
    });

    res.json({
      ok: true,
      listing,
    });
  } catch (e: any) {
    res.status(500).json({
      ok: false,
      error: e?.message ?? "dev create listing failed",
    });
  }
});