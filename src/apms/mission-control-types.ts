/**
 * Mission Control shared models.
 * Every dashboard, AI insight and audit should consume these contracts.
 */

import type { AuditEntry, AuditTimeline } from "./audit-types";

export interface FreedomMetrics {
  /**
   * Minutes returned to the host.
   */
  minutesReturned: number;

  /**
   * Human interventions avoided.
   */
  interventionsAvoided: number;

  /**
   * Autonomous decisions executed.
   */
  autonomousDecisions: number;
}

export interface AutonomyScore {
  /**
   * 0-100
   */
  score: number;

  /**
   * Percentage of operations completed
   * without manual intervention.
   */
  operationalSuccessRate: number;

  /**
   * Human interventions required.
   */
  humanInterventions: number;
}

export interface ConfidenceScore {
  /**
   * Overall system confidence.
   */
  score: number;

  /**
   * Confidence by engine.
   */
  engines: Record<string, number>;
}

export interface EngineHealth {
  engine: string;

  status:
    | "HEALTHY"
    | "WARNING"
    | "ERROR";

  lastExecutionAt?: Date;

  message?: string;
}

export type AutopilotStatus =
  | "ACTIVE"
  | "NEEDS_ATTENTION"
  | "PAUSED"
  | "ERROR";

export interface MissionControlAction {
  /**
   * Human-readable action title.
   */
  title: string;

  /**
   * Optional explanation for why this action matters.
   */
  description?: string;

  /**
   * Engine or area related to this action.
   */
  engine?: string;

  /**
   * Action priority.
   */
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

  /**
   * Whether this requires host intervention.
   */
  requiresHumanAction: boolean;

  /**
   * Internal Prisma reservation identifier.
   *
   * This value may be used internally to open the Reservation Detail page,
   * but it must never be displayed to hosts or guests.
   */
  reservationId?: string | null;

  /**
   * Official host-facing and guest-facing reservation reference.
   */
  reservationNumber?: string | null;

  /**
   * Guest related to the operational issue.
   */
  guestName?: string | null;

  /**
   * Host-friendly explanation of the exact operational problem.
   */
  issue?: string | null;

  /**
   * Time of the audit signal that generated or updated the action.
   */
  lastSignalAt?: Date | string | null;

  /**
   * Audit decision that produced this recommended action.
   */
  decisionId?: string | null;

  /**
   * Whether Pin&Go can attempt to resolve the issue automatically.
   */
  canAutoResolve?: boolean;
}
export interface MissionControlSnapshot {
  /**
   * Property, reservation or organization being summarized.
   */
  entityId: string;

  /**
   * Current autopilot status.
   */
  autopilotStatus: AutopilotStatus;

  /**
   * Time returned to the host and interventions avoided.
   */
  freedomMetrics: FreedomMetrics;

  /**
   * Autonomy performance.
   */
  autonomyScore: AutonomyScore;

  /**
   * System confidence.
   */
  confidenceScore: ConfidenceScore;

  /**
   * Health by APMS engine.
   */
  engineHealth: EngineHealth[];

  /**
   * Recent audit entries from APMS engines.
   */
  recentAuditEntries?: AuditEntry[];

  /**
   * Full audit timeline when available.
   */
  auditTimeline?: AuditTimeline;

  /**
   * Recommended actions for the host or system.
   */
  recommendedActions?: MissionControlAction[];

  /**
   * Last time this snapshot was calculated.
   */
  generatedAt: Date;
}