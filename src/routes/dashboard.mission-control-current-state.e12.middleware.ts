import type { NextFunction, Request, Response } from "express";

import type {
  MissionControlOperationalItem,
  MissionControlSnapshot,
} from "../apms/mission-control-types";
import {
  deriveMissionControlCurrentStateSummary,
} from "../apms/mission-control-projection";

const MISSION_CONTROL_PROPERTY_PATH =
  /^\/api\/dashboard\/properties\/[^/]+\/mission-control\/?$/;

type MissionControlEnvelope = {
  ok?: boolean;
  item?: MissionControlSnapshot & {
    currentOperationalState?: MissionControlOperationalItem[];
  };
  [key: string]: unknown;
};

export function applyMissionControlCurrentStateCutover(
  body: MissionControlEnvelope
): MissionControlEnvelope {
  if (
    body?.ok !== true ||
    !body.item ||
    !Array.isArray(body.item.currentOperationalState)
  ) {
    return body;
  }

  const currentStateSummary =
    deriveMissionControlCurrentStateSummary(
      body.item.currentOperationalState
    );

  return {
    ...body,
    item: {
      ...body.item,
      // E12: OperationalIssue/currentOperationalState is the only source of
      // current autopilot and engine-health state. ApmsAuditEntry remains in
      // activityHistory/recentAuditEntries/auditTimeline as historical proof.
      autopilotStatus:
        currentStateSummary.autopilotStatus,
      engineHealth:
        currentStateSummary.engineHealth,
    },
  };
}

/**
 * Compatibility cutover for the existing Mission Control endpoint.
 *
 * The legacy route still assembles immutable audit history. E12 intercepts the
 * final response before it leaves Express and replaces only fields that claim
 * to represent current operational state. No database writes or provider calls
 * are performed here.
 */
export function missionControlCurrentStateCutoverMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (
    req.method !== "GET" ||
    !MISSION_CONTROL_PROPERTY_PATH.test(req.path)
  ) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);

  res.json = (body: any) => {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return originalJson(body);
    }

    return originalJson(
      applyMissionControlCurrentStateCutover(
        body as MissionControlEnvelope
      )
    );
  };

  next();
}
