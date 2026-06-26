import type { AuditEntry } from "./audit-types";
import type { DecisionResult } from "./decision-types";
import type { MissionControlAction } from "./mission-control-types";
import type { OrchestratorInterventionLevel } from "./orchestrator-types";

/**
 * Generic contract for every Pin&Go APMS Decision Engine.
 *
 * Engines evaluate context and return structured decisions.
 * They do not execute actions directly.
 */
export interface DecisionEngine<TContext, TValue = unknown> {
  evaluate(context: TContext): Promise<DecisionResult<TValue>>;
}

/**
 * Optional runtime context provided by the APMS Orchestrator
 * when an engine is evaluated as part of an autonomous workflow.
 */
export interface DecisionEngineExecutionContext {
  /**
   * Entity being evaluated.
   * Example: propertyId, reservationId, accessGrantId.
   */
  entityId?: string;

  /**
   * Workflow or pipeline id that triggered this evaluation.
   */
  pipelineId?: string;

  /**
   * Task id inside the execution pipeline.
   */
  taskId?: string;

  /**
   * Whether this evaluation was triggered automatically.
   */
  autonomous?: boolean;

  /**
   * Optional correlation id for tracing logs, audits and workflows.
   */
  correlationId?: string;

  /**
   * Additional runtime metadata.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Optional APMS-level evaluation envelope.
 *
 * This does not replace DecisionResult.
 * It allows future engines to return audit and Mission Control context
 * without changing the core evaluate contract.
 */
export interface DecisionEngineEvaluation<TValue = unknown> {
  /**
   * Core structured decision result.
   */
  result: DecisionResult<TValue>;

  /**
   * Audit entries generated from the decision.
   */
  auditEntries?: AuditEntry[];

  /**
   * Whether the decision requires human intervention.
   */
  requiresHumanIntervention?: boolean;

  /**
   * Intervention level for Mission Control and Orchestrator.
   */
  interventionLevel?: OrchestratorInterventionLevel;

  /**
   * Recommended action for the host or system.
   */
  recommendedAction?: MissionControlAction;

  /**
   * Additional APMS metadata.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Optional contract for engines that can evaluate with APMS runtime context.
 *
 * This keeps the base DecisionEngine simple while allowing autonomous
 * workflows to pass orchestration and audit context when needed.
 */
export interface ContextAwareDecisionEngine<TContext, TValue = unknown>
  extends DecisionEngine<TContext, TValue> {
  evaluateWithContext(
    context: TContext,
    executionContext: DecisionEngineExecutionContext
  ): Promise<DecisionEngineEvaluation<TValue>>;
}