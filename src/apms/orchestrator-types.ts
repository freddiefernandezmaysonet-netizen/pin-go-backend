import type { AuditEntry } from "./audit-types";
import type { DecisionResult } from "./decision-types";
import type { MissionControlAction, MissionControlSnapshot } from "./mission-control-types";

export type OrchestratorTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED";

export type ExecutionPipelineStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "PARTIAL"
  | "SKIPPED";

export type OrchestratorInterventionLevel =
  | "NONE"
  | "REVIEW"
  | "REQUIRED"
  | "URGENT";

export interface OrchestratorTask<TContext = unknown, TValue = unknown> {
  id: string;
  engine: string;
  name: string;
  context: TContext;
  status: OrchestratorTaskStatus;
  result?: DecisionResult<TValue>;
  auditEntry?: AuditEntry;
  error?: string;
  requiresHumanIntervention?: boolean;
  interventionLevel?: OrchestratorInterventionLevel;
  recommendedAction?: MissionControlAction;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionPipeline<TContext = unknown> {
  id: string;
  name: string;
  context: TContext;
  status?: ExecutionPipelineStatus;
  tasks: OrchestratorTask[];
  auditEntries?: AuditEntry[];
  missionControlSnapshot?: MissionControlSnapshot;
  requiresHumanIntervention?: boolean;
  interventionLevel?: OrchestratorInterventionLevel;
  recommendedActions?: MissionControlAction[];
  createdAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}