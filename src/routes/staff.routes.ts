import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { PropertyStaffRole } from "@prisma/client";

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

  // GET /staff/:id/property-assignments
  router.get("/:id/property-assignments", async (req, res) => {
    try {
      const staffMemberId = String(req.params.id ?? "");

      if (!staffMemberId) {
        return res.status(400).json({ error: "staffMemberId is required" });
      }

      const staff = await prisma.staffMember.findUnique({
        where: { id: staffMemberId },
        select: { id: true, organizationId: true },
      });

      if (!staff) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const properties = await prisma.property.findMany({
        where: {
          organizationId: staff.organizationId,
          status: "ACTIVE",
        },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          propertyStaff: {
            where: { staffMemberId },
            select: {
              id: true,
              role: true,
              backupOrder: true,
              isActive: true,
            },
          },
        },
      });

      return res.json({
        staffMemberId,
        properties: properties.map((p) => ({
          id: p.id,
          name: p.name,
          assignment: p.propertyStaff[0] ?? null,
        })),
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // PUT /staff/:id/property-assignments
  router.put("/:id/property-assignments", async (req, res) => {
    try {
      const staffMemberId = String(req.params.id ?? "");
      const assignments = Array.isArray(req.body?.assignments)
        ? req.body.assignments
        : [];

      if (!staffMemberId) {
        return res.status(400).json({ error: "staffMemberId is required" });
      }

      const staff = await prisma.staffMember.findUnique({
        where: { id: staffMemberId },
        select: { id: true, organizationId: true },
      });

      if (!staff) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const result = await prisma.$transaction(async (tx) => {
        const updated: any[] = [];

        for (const item of assignments) {
          const propertyId = String(item.propertyId ?? "");
          const role = String(item.role ?? "");
          const isActive = Boolean(item.isActive);

          if (!propertyId) continue;

          const property = await tx.property.findFirst({
            where: {
              id: propertyId,
              organizationId: staff.organizationId,
            },
            select: { id: true },
          });

          if (!property) continue;

          if (!isActive) {
            await tx.propertyStaff.deleteMany({
              where: {
                propertyId,
                staffMemberId,
              },
            });
            continue;
          }

          if (role !== "PRIMARY" && role !== "BACKUP") {
            throw new Error("Invalid role. Use PRIMARY or BACKUP.");
          }

          const backupOrder =
            role === "BACKUP"
              ? Number.isFinite(Number(item.backupOrder))
                ? Math.max(1, Math.trunc(Number(item.backupOrder)))
                : 1
              : null;

          // Solo un PRIMARY activo por propiedad.
          if (role === "PRIMARY") {
            await tx.propertyStaff.updateMany({
              where: {
                propertyId,
                role: PropertyStaffRole.PRIMARY,
                isActive: true,
                staffMemberId: { not: staffMemberId },
              },
              data: {
                role: PropertyStaffRole.BACKUP,
                backupOrder: 1,
              },
            });
          }

          const saved = await tx.propertyStaff.upsert({
            where: {
              propertyId_staffMemberId: {
                propertyId,
                staffMemberId,
              },
            },
            create: {
              propertyId,
              staffMemberId,
              role: role as PropertyStaffRole,
              backupOrder,
              isActive: true,
            },
            update: {
              role: role as PropertyStaffRole,
              backupOrder,
              isActive: true,
            },
          });

          updated.push(saved);
        }

        return updated;
      });

      return res.json({ ok: true, assignments: result });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  return router;
}