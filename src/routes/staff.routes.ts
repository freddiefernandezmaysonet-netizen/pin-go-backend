import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

export function buildStaffRouter(prisma: PrismaClient) {
  const router = Router();

  // POST /staff
  router.post("/", async (req, res) => {
    try {
      const {
        organizationId,
        fullName,
        phoneE164,
        companyName,
        photoUrl,
        ttlockCardRef,
      } = req.body ?? {};

      if (!organizationId) return res.status(400).json({ error: "organizationId is required" });
      if (!fullName) return res.status(400).json({ error: "fullName is required" });

      const staff = await prisma.staffMember.create({
        data: {
          organizationId: String(organizationId),
          fullName: String(fullName),
          phoneE164: phoneE164 ? String(phoneE164) : null,
          companyName: companyName ? String(companyName) : null,
          photoUrl: photoUrl ? String(photoUrl) : null,
          ttlockCardRef: ttlockCardRef ? String(ttlockCardRef) : null,
          isActive: true,
        },
      });

      return res.status(201).json(staff);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // GET /staff?organizationId=...
  router.get("/", async (req, res) => {
    try {
      const organizationId = String(req.query.organizationId ?? "");
      if (!organizationId) {
        return res.status(400).json({ error: "organizationId query param is required" });
      }

      const staff = await prisma.staffMember.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
      });

      return res.json(staff);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  return router;
}
