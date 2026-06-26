import type { DecisionResult } from "./decision-types";

export type OrchestratorTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED";

export interface OrchestratorTask<TContext = unknown, TValue = unknown> {
  id: string;
  engine: string;
  name: string;
  context: TContext;
  status: OrchestratorTaskStatus;
  result?: DecisionResult<TValue>;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ExecutionPipeline<TContext = unknown> {
  id: string;
  name: string;
  context: TContext;
  tasks: OrchestratorTask[];
}