import { Router } from "express";
import { Prisma } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthenticatedUser } from "../middleware/requireAuth";
import { defaultDiscountConfig, discountConfigSchema } from "../services/direct-booking-discounts.policy";
import { calculateDiscountedDirectQuote } from "../services/direct-booking-discounted-quote.service";

export const directDiscountsRouter = Router();
const path = "/api/dashboard/properties/:id/direct-discounts";
const saveSchema = z.object({ config: discountConfigSchema, version: z.number().int().min(0) }).strict();
for (const method of ["get", "put", "post"] as const) {
  directDiscountsRouter[method](path + (method === "post" ? "/preview" : ""), requireAuth, async (req, res) => {
    try {
      const user = (req as typeof req & { user: AuthenticatedUser }).user;
      if (!user.orgId) return res.status(403).json({ error: "FORBIDDEN" });
      const property = await prisma.property.findFirst({ where: { id: String(req.params.id), organizationId: user.orgId },
        select: { id: true, timezone: true, checkInTime: true, checkOutTime: true, directDiscountConfig: true } });
      if (!property) return res.status(404).json({ error: "PROPERTY_NOT_FOUND" });
      if (method === "get") return res.json({ config: property.directDiscountConfig?.config ?? defaultDiscountConfig, version: property.directDiscountConfig?.version ?? 0 });
      if (!["ORG_ADMIN", "PLATFORM_ADMIN"].includes(user.role ?? "")) return res.status(403).json({ error: "FORBIDDEN" });
      const config = discountConfigSchema.parse(req.body?.config);
      if (method === "post") {
        const dates = z.object({ checkIn: z.iso.date(), checkOut: z.iso.date() }).parse(req.body);
        const days = (Date.parse(dates.checkOut) - Date.parse(dates.checkIn)) / 86400000;
        if (days <= 0 || days > 730) return res.status(400).json({ error: "INVALID_STAY" });
        const zone = property.timezone || "America/Puerto_Rico";
        const pricing = await calculateDiscountedDirectQuote({ propertyId: property.id,
          checkIn: fromZonedTime(`${dates.checkIn}T${property.checkInTime || "15:00"}:00`, zone),
          checkOut: fromZonedTime(`${dates.checkOut}T${property.checkOutTime || "11:00"}:00`, zone),
          includeAuditEntries: false,
        }, config);
        return res.json({ pricing });
      }
      const { version } = saveSchema.parse(req.body);
      if (version === 0) {
        const saved = await prisma.directBookingDiscountConfig.create({ data: { propertyId: property.id, config } });
        return res.json({ config: saved.config, version: saved.version });
      }
      const saved = await prisma.directBookingDiscountConfig.updateMany({ where: { propertyId: property.id, version }, data: { config, version: { increment: 1 } } });
      if (!saved.count) return res.status(409).json({ error: "DISCOUNTS_CHANGED_RELOAD" });
      return res.json({ config, version: version + 1 });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "INVALID_DISCOUNT_CONFIGURATION", details: error.issues });
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return res.status(409).json({ error: "DISCOUNTS_CHANGED_RELOAD" });
      console.error("[direct-discounts]", error instanceof Error ? error.name : "UnknownError");
      return res.status(500).json({ error: "DISCOUNTS_UNAVAILABLE" });
    }
  });
}
