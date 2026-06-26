import type { DecisionResult } from "./decision-types";

/**
 * Generic contract for every Pin&Go APMS Decision Engine.
 *
 * Engines evaluate context and return structured decisions.
 * They do not execute actions directly.
 */
export interface DecisionEngine<TContext, TValue = unknown> {
  evaluate(context: TContext): Promise<DecisionResult<TValue>>;
}