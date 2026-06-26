import type { AuditDecisionTrace, AuditEntry } from "./audit-types";

type ReservationAuditStepInput = {
  rule: string;
  label: string;
  applied: boolean;
  previousValue?: unknown;
  newValue?: unknown;
  confidence?: number;
  metadata?: Record<string, unknown>;
};

type ReservationAuditEntryInput = {
  reservationId: string;
  propertyId: string;
  decisionId?: string;
  steps: ReservationAuditStepInput[];
  startedAt?: Date;
  completedAt?: Date;
  reason?: string;
  metadata?: Record<string, unknown>;
};

function toReservationAuditDecisionTrace(
  step: ReservationAuditStepInput
): AuditDecisionTrace {
  return {
    engine: "Reservation",
    rule: step.rule,
    label: step.label,
    previousValue: step.previousValue,
    newValue: step.newValue,
    adjustment: null,
    adjustmentPercent: null,
    applied: step.applied,
    confidence: step.confidence ?? 100,
    metadata: step.metadata,
  };
}

function getAppliedRules(decisions: AuditDecisionTrace[]) {
  return decisions
    .filter((decision) => decision.applied)
    .map((decision) => decision.rule);
}

function getReservationAuditSummary(decisions: AuditDecisionTrace[]) {
  const appliedRules = getAppliedRules(decisions);

  if (appliedRules.includes("ACTIVE_LOCK_MISSING")) {
    return "Reservation Auto Pilot received the reservation but could not create guest access because no active lock was found.";
  }

  if (appliedRules.includes("ACCESS_GRANT_ENSURED")) {
    return "Reservation Auto Pilot completed reservation intake and prepared guest access.";
  }

  if (appliedRules.includes("RESERVATION_RECONCILED")) {
    return "Reservation Auto Pilot completed reservation intake and reconciliation.";
  }

  return "Reservation Auto Pilot processed the reservation intake.";
}

function getReservationAuditRecommendedAction(
  decisions: AuditDecisionTrace[]
) {
  const appliedRules = getAppliedRules(decisions);

  if (appliedRules.includes("ACTIVE_LOCK_MISSING")) {
    return "Assign an active smart lock to this property so Pin&Go can create guest access automatically.";
  }

  return undefined;
}

function getReservationAuditSeverity(decisions: AuditDecisionTrace[]) {
  const appliedRules = getAppliedRules(decisions);

  if (appliedRules.includes("ACTIVE_LOCK_MISSING")) {
    return "WARNING" as const;
  }

  return "INFO" as const;
}

function getReservationAuditStatus(decisions: AuditDecisionTrace[]) {
  const appliedRules = getAppliedRules(decisions);

  if (appliedRules.includes("RESERVATION_FAILED")) {
    return "FAILED" as const;
  }

  return "SUCCESS" as const;
}

export function createReservationAuditEntry(
  input: ReservationAuditEntryInput
): AuditEntry {
  const startedAt = input.startedAt ?? new Date();
  const completedAt = input.completedAt ?? new Date();
  const decisions = input.steps.map(toReservationAuditDecisionTrace);

  return {
    engine: "Reservation",
    decisionId:
      input.decisionId ??
      `reservation-autopilot:${input.propertyId}:${input.reservationId}`,
    entityType: "RESERVATION",
    entityId: input.reservationId,
    eventType: "DECISION_APPLIED",
    status: getReservationAuditStatus(decisions),
    severity: getReservationAuditSeverity(decisions),
    summary: getReservationAuditSummary(decisions),
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    reason: input.reason,
    decisions,
    recommendedAction: getReservationAuditRecommendedAction(decisions),
    metadata: {
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      ...input.metadata,
    },
  };
}