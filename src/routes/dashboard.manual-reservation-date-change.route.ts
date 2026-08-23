import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  changeManualReservationDatesByHost,
  ManualReservationDateChangeError,
} from "../services/manual-reservation-date-change.service";

export const dashboardManualReservationDateChangeRouter = Router();

dashboardManualReservationDateChangeRouter.patch(
  "/api/dashboard/reservations/:id/dates",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const organizationId = String(user.orgId ?? "").trim();
      const requestedByUserId = String(user.id ?? user.userId ?? "").trim();
      const reservationId = String(req.params.id ?? "").trim();

      if (!requestedByUserId) {
        return res.status(401).json({ ok: false, error: "AUTHENTICATED_USER_ID_REQUIRED" });
      }

      const result = await changeManualReservationDatesByHost({
        organizationId,
        reservationId,
        checkInDate: String(req.body?.checkInDate ?? "").trim(),
        checkOutDate: String(req.body?.checkOutDate ?? "").trim(),
        requestedByUserId,
      });

      return res.json(result);
    } catch (error: any) {
      console.error("[DASHBOARD_MANUAL_RESERVATION_DATE_CHANGE_ERROR]", error);

      if (error instanceof ManualReservationDateChangeError || error?.code) {
        return res.status(error?.statusCode || 400).json({
          ok: false,
          error: error?.code || "MANUAL_RESERVATION_DATE_CHANGE_ERROR",
          message: error?.message || "Unable to change manual reservation dates.",
          details: error?.details,
        });
      }

      return res.status(500).json({
        ok: false,
        error: "MANUAL_RESERVATION_DATE_CHANGE_ERROR",
        message: "Unable to change manual reservation dates.",
      });
    }
  }
);
