import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  changeManualReservationDatesByHost,
  previewManualReservationDateChangeByHost,
  ManualReservationDateChangeError,
} from "../services/manual-reservation-date-change.service";

export const dashboardManualReservationDateChangeRouter = Router();

function handleError(res: any, error: any) {
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

dashboardManualReservationDateChangeRouter.post(
  "/api/dashboard/reservations/:id/dates/preview",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const result = await previewManualReservationDateChangeByHost({
        organizationId: String(user.orgId ?? "").trim(),
        reservationId: String(req.params.id ?? "").trim(),
        checkInDate: String(req.body?.checkInDate ?? "").trim(),
        checkOutDate: String(req.body?.checkOutDate ?? "").trim(),
      });
      return res.json(result);
    } catch (error: any) {
      return handleError(res, error);
    }
  }
);

dashboardManualReservationDateChangeRouter.patch(
  "/api/dashboard/reservations/:id/dates",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const requestedByUserId = String(user.id ?? user.userId ?? "").trim();
      if (!requestedByUserId) {
        return res.status(401).json({ ok: false, error: "AUTHENTICATED_USER_ID_REQUIRED" });
      }

      const result = await changeManualReservationDatesByHost({
        organizationId: String(user.orgId ?? "").trim(),
        reservationId: String(req.params.id ?? "").trim(),
        checkInDate: String(req.body?.checkInDate ?? "").trim(),
        checkOutDate: String(req.body?.checkOutDate ?? "").trim(),
        requestedByUserId,
        expectedReservationUpdatedAt: String(req.body?.expectedReservationUpdatedAt ?? "").trim(),
        expectedProposedTotalAmount: Number(req.body?.expectedProposedTotalAmount),
      });
      return res.json(result);
    } catch (error: any) {
      return handleError(res, error);
    }
  }
);
