import type { DecisionStep } from "./decision-types";
import type { AuditDecisionTrace, AuditEntry } from "./audit-types";

type RevenueAuditEntryInput = {
  entityId: string;
  decisionId: string;
  pricingBreakdown: DecisionStep<number>[];
  startedAt?: Date;
  completedAt?: Date;
  reason?: string;
  metadata?: Record<string, unknown>;
};

function toAuditDecisionTrace(
  decision: DecisionStep<number>
): AuditDecisionTrace {
  return {
    engine: decision.engine,
    rule: decision.rule,
    label: decision.label,
    previousValue: decision.previousValue,
    newValue: decision.newValue,
    adjustment: decision.adjustment,
    adjustmentPercent: decision.adjustmentPercent,
    applied: decision.applied,
    confidence: decision.confidence,
    metadata: decision.metadata,
  };
}

function getRevenueAuditSummary(decisions: AuditDecisionTrace[]) {
  const appliedRules = decisions
    .filter((decision) => decision.applied)
    .map((decision) => decision.rule);

  if (appliedRules.includes("MINIMUM_NIGHTLY_RATE")) {
    return "Revenue Engine completed pricing decision and protected the host with the minimum nightly rate.";
  }

  if (appliedRules.includes("MAXIMUM_NIGHTLY_RATE")) {
    return "Revenue Engine completed pricing decision and protected the listing with the maximum nightly rate.";
  }

  if (appliedRules.includes("NIGHTLY_RATE_ROUNDING")) {
    return "Revenue Engine completed pricing decision and rounded the nightly rate for guest clarity.";
  }

  if (appliedRules.length > 0) {
    return "Revenue Engine completed pricing decision with active pricing rules.";
  }

  return "Revenue Engine completed pricing decision with no pricing adjustment required.";
}

function getRevenueAuditRecommendedAction(decisions: AuditDecisionTrace[]) {
  const appliedRules = decisions
    .filter((decision) => decision.applied)
    .map((decision) => decision.rule);

  if (appliedRules.includes("MINIMUM_NIGHTLY_RATE")) {
    return "Review minimum nightly rate periodically to ensure it still protects host revenue.";
  }

  if (appliedRules.includes("MAXIMUM_NIGHTLY_RATE")) {
    return "Review maximum nightly rate periodically to ensure it does not cap high-demand revenue too aggressively.";
  }

  return undefined;
}

export function mapRevenuePricingBreakdownToAuditDecisionTraces(
  pricingBreakdown: DecisionStep<number>[]
): AuditDecisionTrace[] {
  return pricingBreakdown.map(toAuditDecisionTrace);
}

export function createRevenueAuditEntry(
  input: RevenueAuditEntryInput
): AuditEntry {
  const startedAt = input.startedAt ?? new Date();
  const completedAt = input.completedAt ?? new Date();
  const decisions = mapRevenuePricingBreakdownToAuditDecisionTraces(
    input.pricingBreakdown
  );

  return {
    engine: "Revenue",
    decisionId: input.decisionId,
    entityType: "REVENUE",
    entityId: input.entityId,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary: getRevenueAuditSummary(decisions),
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    reason: input.reason,
    decisions,
    recommendedAction: getRevenueAuditRecommendedAction(decisions),
    metadata: input.metadata,
  };
}