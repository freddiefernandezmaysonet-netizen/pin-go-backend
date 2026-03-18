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

      if (!organizationId) {
        return res.status(400).json({ error: "organizationId is required" });
      }

      if (!fullName) {
        return res.status(400).json({ error: "fullName is required" });
      }

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

  // PATCH /staff/:id
  router.patch("/:id", async (req, res) => {
    try {
      const id = String(req.params.id ?? "");
      const {
        fullName,
        phoneE164,
        companyName,
        photoUrl,
        ttlockCardRef,
      } = req.body ?? {};

      if (!id) {
        return res.status(400).json({ error: "id is required" });
      }

      const existing = await prisma.staffMember.findUnique({
        where: { id },
      });

      if (!existing) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const updated = await prisma.staffMember.update({
        where: { id },
        data: {
          fullName: fullName !== undefined ? String(fullName) : existing.fullName,
          phoneE164:
            phoneE164 !== undefined
              ? phoneE164
                ? String(phoneE164)
                : null
              : existing.phoneE164,
          companyName:
            companyName !== undefined
              ? companyName
                ? String(companyName)
                : null
              : existing.companyName,
          photoUrl:
            photoUrl !== undefined
              ? photoUrl
                ? String(photoUrl)
                : null
              : existing.photoUrl,
          ttlockCardRef:
            ttlockCardRef !== undefined
              ? ttlockCardRef
                ? String(ttlockCardRef)
                : null
              : existing.ttlockCardRef,
        },
      });

      return res.json(updated);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // PATCH /staff/:id/archive
  router.patch("/:id/archive", async (req, res) => {
    try {
      const id = String(req.params.id ?? "");

      if (!id) {
        return res.status(400).json({ error: "id is required" });
      }

      const existing = await prisma.staffMember.findUnique({
        where: { id },
      });

      if (!existing) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const updated = await prisma.staffMember.update({
        where: { id },
        data: {
          isActive: false,
        },
      });

      return res.json(updated);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  return router;
}