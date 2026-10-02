import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { buildPublicStaysSitemap } from "../services/public-stays-sitemap.service.js";

export function buildPublicStaysSitemapRouter(
  db: Pick<PrismaClient, "property">,
  resolveBrand: Parameters<typeof buildPublicStaysSitemap>[1],
) {
  const router = Router();
  router.get("/sitemap.xml", async (_req, res) => {
    try {
      const xml = await buildPublicStaysSitemap(db, resolveBrand);
      return res.type("application/xml").set("Cache-Control", "public, max-age=300").send(xml);
    } catch (error) {
      console.error("[public-stays sitemap]", error instanceof Error ? error.message : "unavailable");
      return res.status(503).set("Cache-Control", "no-store").send("Sitemap temporarily unavailable");
    }
  });
  return router;
}
