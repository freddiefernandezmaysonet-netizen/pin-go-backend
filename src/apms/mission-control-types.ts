/**
 * Mission Control shared models.
 * Every dashboard, AI insight and audit should consume these contracts.
 */

import type { AuditEntry, AuditTimeline } from "./audit-types";
import type { OperationalItem } from "./operational-intelligence-types";

/**
 * Host-safe Operational Intelligence contract.
 *
 * Internal OIE identifiers, audit references, automation action codes and
 * technical metadata must not be returned to the dashboard.
 *
 * reservationId remains available only for internal dashboard navigation and
 * must never be rendered as visible text.
 */
export type MissionControlOperationalItem = Pick<
  OperationalItem,
  | "issueCode"
  | "title"
  | "issue"
  | "operationalImpact"
  | "recommendedAction"
  | "nextAutomaticStep"
  | "engine"
  | "severity"
  | "workflowState"
  | "visibility"
  | "responsibleActor"
  | "actionRequired"
  | "canAutoResolve"
  | "autoResolveStatus"
  | "reservationId"
  | "reservationNumber"
  | "guestName"
  | "cleanerName"
  | "firstDetectedAt"
  | "lastSignalAt"
  | "resolvedAt"
  | "resolutionCode"
  | "resolutionSummary"
  | "resolutionType"
  | "resolvedBy"
  | "actionTarget"
  | "openUrl"
  | "secondaryActionUrl"
>;
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
   * Exact host-facing action recommended by Pin&Go.
   */
  recommendedAction?: string | null;

  /**
   * Whether Pin&Go can attempt to resolve the issue automatically.
   */
  canAutoResolve?: boolean;
}

export interface GuestJourneyEngineMetrics {
  /**
   * Active reservations included in the Guest Journey measurement.
   */
  activeReservations: number;

  /**
   * Active reservations whose journey remains at the initial confirmed state.
   */
  reservationConfirmed: number;

  /**
   * Guests who still need to complete secure pre-check-in.
   */
  verificationPending: number;

  /**
   * Guests who completed verification but whose access is not scheduled yet.
   */
  verificationCompleted: number;

  /**
   * Guests whose digital access has been scheduled.
   */
  accessScheduled: number;

  /**
   * Guests fully ready for arrival.
   */
  readyForArrival: number;

  /**
   * Percentage of active journeys that reached READY_FOR_ARRIVAL.
   * Range: 0-100.
   */
  completionRate: number;

  /**
   * Open Guest Journey issues that explicitly require host action.
   */
  hostInterventionRequired: number;
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
   * Current Guest Journey operational state for this property.
   */
  guestJourneyMetrics?: GuestJourneyEngineMetrics;

  /**
   * Recent audit entries from APMS engines.
   */
  recentAuditEntries?: AuditEntry[];

  /**
   * Full audit timeline when available.
   */
  auditTimeline?: AuditTimeline;

   /**
   * Recommended actions generated by the legacy Mission Control mapper.
   *
   * This remains available as a compatibility fallback while APMS engines
   * migrate gradually to Operational Intelligence.
   */
  recommendedActions?: MissionControlAction[];

  /**
   * Host-visible operational workflows already classified by OIE.
   *
   * Mission Control must render these items by workflowState and must not
   * reinterpret engine names, audit reasons or technical metadata.
   */
    operationalItems?: MissionControlOperationalItem[];

  /**
   * Last time this snapshot was calculated.
   */
  generatedAt: Date;
}