import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { StaffAssignmentStatus, StaffAccessMethod } from "@prisma/client";

export function buildCleaningRouter(prisma: PrismaClient) {
  const router = Router();

  // POST /reservations/:id/cleaning-assignments
  router.post("/reservations/:id/cleaning-assignments", async (req, res) => {
    try {
      const reservationId = req.params.id;
      const {
        staffMemberId,
        startOffsetMinutes,
        durationMinutes,
        startsAt,
        endsAt,
        method,
      } = req.body ?? {};

      if (!staffMemberId) {
        return res.status(400).json({ error: "staffMemberId is required" });
      }

      const reservation = await prisma.reservation.findUnique({
        where: { id: reservationId },
        include: { property: true },
      });

      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      let s: Date;
      let e: Date;

      if (startsAt && endsAt) {
        s = new Date(startsAt);
        e = new Date(endsAt);
      } else {
        const offset =
          typeof startOffsetMinutes === "number"
            ? startOffsetMinutes
            : reservation.property.cleaningStartOffsetMinutes;

        const duration =
          typeof durationMinutes === "number"
            ? durationMinutes
            : reservation.property.cleaningDurationMinutes;

        s = new Date(reservation.checkOut.getTime() + offset * 60_000);
        e = new Date(s.getTime() + duration * 60_000);
      }

      if (isNaN(s.getTime())) {
        return res.status(400).json({ error: "startsAt invalid" });
      }
      if (isNaN(e.getTime())) {
        return res.status(400).json({ error: "endsAt invalid" });
      }
      if (e <= s) {
        return res.status(400).json({ error: "endsAt must be > startsAt" });
      }

      const assignment = await prisma.staffAssignment.create({
        data: {
          reservationId,
          staffMemberId,
          startsAt: s,
          endsAt: e,
          status: StaffAssignmentStatus.SCHEDULED,
          method:
            method === "EKEY_TIMEBOUND"
              ? StaffAccessMethod.EKEY_TIMEBOUND
              : StaffAccessMethod.NFC_TIMEBOUND,
        },
      });

      return res.status(201).json(assignment);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  return router;
}
