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
  steps: DecisionStep<TValue>[];

  finalValue: TValue;
}