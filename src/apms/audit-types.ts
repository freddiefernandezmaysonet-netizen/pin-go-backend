/**
 * Shared audit contracts for every APMS engine.
 */

export type AuditStatus =
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED";

export interface AuditEntry {
  /**
   * Engine that executed.
   */
  engine: string;

  /**
   * Decision identifier.
   */
  decisionId: string;

  /**
   * Execution result.
   */
  status: AuditStatus;

  /**
   * UTC timestamps.
   */
  startedAt: Date;

  completedAt: Date;

  /**
   * Execution duration.
   */
  durationMs: number;

  /**
   * Optional explanation.
   */
  reason?: string;

  /**
   * Engine metadata.
   */
  metadata?: Record<string, unknown>;
}

export interface AuditTimeline {
  /**
   * Reservation, Property, Access, etc.
   */
  entityId: string;

  entries: AuditEntry[];
}