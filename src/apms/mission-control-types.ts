/**
 * Mission Control shared models.
 * Every dashboard, AI insight and audit should consume these contracts.
 */

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