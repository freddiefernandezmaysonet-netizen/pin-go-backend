import { Router } from "express";

import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import {
  getOrganizationMissionControl,
  MissionControlOrganizationNotFoundError,
} from "../apms/mission-control.service";

export const dashboardMissionControlRouter =
  Router();

dashboardMissionControlRouter.get(
  "/api/dashboard/mission-control",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = String(
        (req as any).user?.orgId ?? ""
      ).trim();

      if (!organizationId) {
        return res.status(401).json({
          ok: false,
          error:
            "MISSING_ORGANIZATION_CONTEXT",
        });
      }

      const item =
        await getOrganizationMissionControl(
          prisma,
          organizationId
        );

      return res.json({
        ok: true,
        item,
      });
    } catch (error) {
      if (
        error instanceof
        MissionControlOrganizationNotFoundError
      ) {
        return res.status(404).json({
          ok: false,
          error: error.code,
          message: error.message,
        });
      }

      console.error(
        "GET /api/dashboard/mission-control error",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "MISSION_CONTROL_READ_MODEL_FAILED",
      });
    }
  }
);
