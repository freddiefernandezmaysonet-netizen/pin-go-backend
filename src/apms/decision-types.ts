/**
 * Pin&Go APMS
 * Shared decision contracts used by every autonomous engine.
 */

export type DecisionStatus =
  | "PENDING"
  | "APPLIED"
  | "SKIPPED"
  | "FAILED";

export interface DecisionStep<TValue = unknown> {
  /**
   * Unique decision identifier.
   */
  decisionId?: string;

  /**
   * Engine that produced the decision.
   * Example:
   * Revenue
   * Access
   * Messaging
   * Cleaning
   */
  engine: string;

  /**
   * Internal rule identifier.
   */
  rule: string;

  /**
   * Human readable label.
   */
  label: string;

  /**
   * Value before this decision.
   */
  previousValue: TValue;

  /**
   * Value after this decision.
   */
  newValue: TValue;

  /**
   * Numeric adjustment.
   */
  adjustment?: number;

  /**
   * Percentage adjustment.
   */
  adjustmentPercent?: number | null;

  /**
   * Engine confidence (0-100).
   */
  confidence: number;

  /**
   * Whether the decision changed anything.
   */
  applied: boolean;

  /**
   * Decision lifecycle status.
   */
  status: DecisionStatus;

  /**
   * Optional explanation.
   */
  reason?: string;

  /**
   * Extra engine metadata.
   */
  metadata?: Record<string, unknown>;

  /**
   * UTC timestamp.
   */
  timestamp: Date;
}

export interface DecisionResult<TValue = unknown> {
  /**
   * Optional decision result identifier.
   */
  decisionId?: string;

  /**
   * Engine that produced this result.
   */
  engine?: string;

  /**
   * Overall decision status.
   */
  status?: DecisionStatus;

  /**
   * Ordered decision steps.
   */
  steps: DecisionStep<TValue>[];

  /**
   * Final value after all decisions.
   */
  finalValue: TValue;

  /**
   * Short human-readable summary.
   */
  summary?: string;

  /**
   * Whether this decision requires host or operator intervention.
   */
  requiresHumanIntervention?: boolean;

  /**
   * Optional explanation or failure reason.
   */
  reason?: string;

  /**
   * Extra engine metadata.
   */
  metadata?: Record<string, unknown>;
}