import {
  evaluateChannexAriDispatchEligibility,
  type ChannexAriDispatchIneligibleReason,
  type ChannexAriDispatchPropertyState,
  type ChannexAriDispatchStatus,
} from "./channex-ari-dispatch.policy";
import type { ChannexAriMessageKind } from "./channex-ari-lifecycle.policy";

export const CHANNEX_ARI_DEFAULT_SELECTION_LIMIT = 25;
export const CHANNEX_ARI_MAX_SELECTION_LIMIT = 100;

export type ChannexAriJobSelectionCandidate = {
  id: string;
  organizationId: string;
  propertyId: string;
  messageKind: ChannexAriMessageKind;
  status: ChannexAriDispatchStatus;
  attemptCount: number;
  nextAttemptAt?: Date | null;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  queuedAt: Date;
  createdAt: Date;
};

export type ChannexAriJobSelectionPropertyState =
  ChannexAriDispatchPropertyState & {
    propertyId: string;
    organizationId: string;
  };

export type ChannexAriJobSelectionActionKind =
  | "RECOVER_STALE_LEASE"
  | "CLAIM";

export type ChannexAriJobSelectionAction = {
  action: ChannexAriJobSelectionActionKind;
  deliveryId: string;
  organizationId: string;
  propertyId: string;
  messageKind: ChannexAriMessageKind;
  partitionKey: string;
  readyAt: Date;
  attemptCount: number;
};

export type ChannexAriJobSelectionSkipReason =
  | ChannexAriDispatchIneligibleReason
  | "PARTITION_ALREADY_SELECTED"
  | "BATCH_LIMIT";

export type ChannexAriJobSelectionDecision = {
  deliveryId: string;
  partitionKey: string;
  action: ChannexAriJobSelectionActionKind | null;
  reason: ChannexAriJobSelectionSkipReason | null;
  nextEligibleAt: Date | null;
};

type NormalizedCandidate = Omit<
  ChannexAriJobSelectionCandidate,
  "nextAttemptAt" | "leaseToken" | "leaseExpiresAt" | "queuedAt" | "createdAt"
> & {
  nextAttemptAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  queuedAt: Date;
  createdAt: Date;
  partitionKey: string;
};

type NormalizedPropertyState = {
  propertyId: string;
  organizationId: string;
  pausedUntil: Date | null;
  availabilityNextAllowedAt: Date | null;
  ratesNextAllowedAt: Date | null;
};

type EligibleAction = ChannexAriJobSelectionAction & {
  priority: number;
  queuedAt: Date;
  createdAt: Date;
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertValidDate(value: Date, errorCode: string): Date {
  const normalized = new Date(value);

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function normalizeOptionalDate(
  value: Date | null | undefined,
  errorCode: string
): Date | null {
  return value == null ? null : assertValidDate(value, errorCode);
}

function assertSelectionLimit(value: number | undefined): number {
  const limit =
    value === undefined ? CHANNEX_ARI_DEFAULT_SELECTION_LIMIT : Number(value);

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CHANNEX_ARI_MAX_SELECTION_LIMIT
  ) {
    throw new Error("CHANNEX_ARI_SELECTION_LIMIT_INVALID");
  }

  return limit;
}

function buildPartitionKey(input: {
  propertyId: string;
  messageKind: ChannexAriMessageKind;
}): string {
  return `${input.propertyId}:${input.messageKind}`;
}

function normalizeCandidate(
  candidate: ChannexAriJobSelectionCandidate,
  index: number
): NormalizedCandidate {
  const id = requireText(
    candidate.id,
    `CHANNEX_ARI_SELECTION_CANDIDATE_${index}_ID_REQUIRED`
  );
  const organizationId = requireText(
    candidate.organizationId,
    `CHANNEX_ARI_SELECTION_CANDIDATE_${index}_ORGANIZATION_ID_REQUIRED`
  );
  const propertyId = requireText(
    candidate.propertyId,
    `CHANNEX_ARI_SELECTION_CANDIDATE_${index}_PROPERTY_ID_REQUIRED`
  );
  const queuedAt = assertValidDate(
    candidate.queuedAt,
    `CHANNEX_ARI_SELECTION_CANDIDATE_${index}_QUEUED_AT_INVALID`
  );
  const createdAt = assertValidDate(
    candidate.createdAt,
    `CHANNEX_ARI_SELECTION_CANDIDATE_${index}_CREATED_AT_INVALID`
  );
  const nextAttemptAt = normalizeOptionalDate(
    candidate.nextAttemptAt,
    `CHANNEX_ARI_SELECTION_CANDIDATE_${index}_NEXT_ATTEMPT_AT_INVALID`
  );
  const leaseExpiresAt = normalizeOptionalDate(
    candidate.leaseExpiresAt,
    `CHANNEX_ARI_SELECTION_CANDIDATE_${index}_LEASE_EXPIRES_AT_INVALID`
  );
  const leaseToken = String(candidate.leaseToken ?? "").trim() || null;

  return {
    ...candidate,
    id,
    organizationId,
    propertyId,
    nextAttemptAt,
    leaseToken,
    leaseExpiresAt,
    queuedAt,
    createdAt,
    partitionKey: buildPartitionKey({
      propertyId,
      messageKind: candidate.messageKind,
    }),
  };
}

function normalizePropertyState(
  state: ChannexAriJobSelectionPropertyState,
  index: number
): NormalizedPropertyState {
  return {
    propertyId: requireText(
      state.propertyId,
      `CHANNEX_ARI_SELECTION_STATE_${index}_PROPERTY_ID_REQUIRED`
    ),
    organizationId: requireText(
      state.organizationId,
      `CHANNEX_ARI_SELECTION_STATE_${index}_ORGANIZATION_ID_REQUIRED`
    ),
    pausedUntil: normalizeOptionalDate(
      state.pausedUntil,
      `CHANNEX_ARI_SELECTION_STATE_${index}_PAUSED_UNTIL_INVALID`
    ),
    availabilityNextAllowedAt: normalizeOptionalDate(
      state.availabilityNextAllowedAt,
      `CHANNEX_ARI_SELECTION_STATE_${index}_AVAILABILITY_NEXT_ALLOWED_AT_INVALID`
    ),
    ratesNextAllowedAt: normalizeOptionalDate(
      state.ratesNextAllowedAt,
      `CHANNEX_ARI_SELECTION_STATE_${index}_RATES_NEXT_ALLOWED_AT_INVALID`
    ),
  };
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareEligibleActions(
  left: EligibleAction,
  right: EligibleAction
): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  const readyAtDifference = left.readyAt.getTime() - right.readyAt.getTime();
  if (readyAtDifference !== 0) return readyAtDifference;

  const queuedAtDifference = left.queuedAt.getTime() - right.queuedAt.getTime();
  if (queuedAtDifference !== 0) return queuedAtDifference;

  const createdAtDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdAtDifference !== 0) return createdAtDifference;

  return compareText(left.deliveryId, right.deliveryId);
}

function toDispatchPropertyState(
  state: NormalizedPropertyState | undefined
): ChannexAriDispatchPropertyState | undefined {
  if (!state) return undefined;

  return {
    pausedUntil: state.pausedUntil,
    availabilityNextAllowedAt: state.availabilityNextAllowedAt,
    ratesNextAllowedAt: state.ratesNextAllowedAt,
  };
}

function buildEligibleAction(input: {
  candidate: NormalizedCandidate;
  propertyState?: NormalizedPropertyState;
  now: Date;
}):
  | { eligibleAction: EligibleAction; decision: null }
  | { eligibleAction: null; decision: ChannexAriJobSelectionDecision } {
  const eligibility = evaluateChannexAriDispatchEligibility({
    delivery: {
      status: input.candidate.status,
      messageKind: input.candidate.messageKind,
      attemptCount: input.candidate.attemptCount,
      nextAttemptAt: input.candidate.nextAttemptAt,
      leaseToken: input.candidate.leaseToken,
      leaseExpiresAt: input.candidate.leaseExpiresAt,
    },
    propertyState: toDispatchPropertyState(input.propertyState),
    now: input.now,
  });

  if (eligibility.reason === "STALE_LEASE") {
    return {
      eligibleAction: {
        action: "RECOVER_STALE_LEASE",
        deliveryId: input.candidate.id,
        organizationId: input.candidate.organizationId,
        propertyId: input.candidate.propertyId,
        messageKind: input.candidate.messageKind,
        partitionKey: input.candidate.partitionKey,
        readyAt: input.candidate.leaseExpiresAt!,
        attemptCount: input.candidate.attemptCount,
        priority: 0,
        queuedAt: input.candidate.queuedAt,
        createdAt: input.candidate.createdAt,
      },
      decision: null,
    };
  }

  if (eligibility.eligible) {
    return {
      eligibleAction: {
        action: "CLAIM",
        deliveryId: input.candidate.id,
        organizationId: input.candidate.organizationId,
        propertyId: input.candidate.propertyId,
        messageKind: input.candidate.messageKind,
        partitionKey: input.candidate.partitionKey,
        readyAt: input.candidate.nextAttemptAt ?? input.candidate.queuedAt,
        attemptCount: input.candidate.attemptCount,
        priority: 1,
        queuedAt: input.candidate.queuedAt,
        createdAt: input.candidate.createdAt,
      },
      decision: null,
    };
  }

  return {
    eligibleAction: null,
    decision: {
      deliveryId: input.candidate.id,
      partitionKey: input.candidate.partitionKey,
      action: null,
      reason: eligibility.reason,
      nextEligibleAt: eligibility.nextEligibleAt,
    },
  };
}

export function selectChannexAriDispatchJobs(input: {
  candidates: ChannexAriJobSelectionCandidate[];
  propertyStates?: ChannexAriJobSelectionPropertyState[];
  now: Date;
  limit?: number;
}) {
  const now = assertValidDate(input.now, "CHANNEX_ARI_SELECTION_NOW_INVALID");
  const limit = assertSelectionLimit(input.limit);

  if (!Array.isArray(input.candidates)) {
    throw new Error("CHANNEX_ARI_SELECTION_CANDIDATES_REQUIRED");
  }

  if (input.propertyStates !== undefined && !Array.isArray(input.propertyStates)) {
    throw new Error("CHANNEX_ARI_SELECTION_PROPERTY_STATES_INVALID");
  }

  const candidates = input.candidates.map(normalizeCandidate);
  const candidateIds = new Set<string>();
  const propertyTenants = new Map<string, string>();

  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new Error("CHANNEX_ARI_SELECTION_DUPLICATE_DELIVERY_ID");
    }
    candidateIds.add(candidate.id);

    const existingTenant = propertyTenants.get(candidate.propertyId);
    if (existingTenant && existingTenant !== candidate.organizationId) {
      throw new Error("CHANNEX_ARI_SELECTION_PROPERTY_TENANT_CONFLICT");
    }
    propertyTenants.set(candidate.propertyId, candidate.organizationId);
  }

  const propertyStates = (input.propertyStates ?? []).map(normalizePropertyState);
  const propertyStateById = new Map<string, NormalizedPropertyState>();

  for (const state of propertyStates) {
    if (propertyStateById.has(state.propertyId)) {
      throw new Error("CHANNEX_ARI_SELECTION_DUPLICATE_PROPERTY_STATE");
    }

    const candidateTenant = propertyTenants.get(state.propertyId);
    if (candidateTenant && candidateTenant !== state.organizationId) {
      throw new Error("CHANNEX_ARI_SELECTION_PROPERTY_STATE_TENANT_MISMATCH");
    }

    propertyStateById.set(state.propertyId, state);
  }

  const eligibleActions: EligibleAction[] = [];
  const decisionByDeliveryId = new Map<
    string,
    ChannexAriJobSelectionDecision
  >();

  for (const candidate of candidates) {
    const result = buildEligibleAction({
      candidate,
      propertyState: propertyStateById.get(candidate.propertyId),
      now,
    });

    if (result.eligibleAction) {
      eligibleActions.push(result.eligibleAction);
    } else {
      decisionByDeliveryId.set(candidate.id, result.decision);
    }
  }

  eligibleActions.sort(compareEligibleActions);

  const actions: ChannexAriJobSelectionAction[] = [];
  const selectedPartitions = new Set<string>();

  for (const eligibleAction of eligibleActions) {
    if (selectedPartitions.has(eligibleAction.partitionKey)) {
      decisionByDeliveryId.set(eligibleAction.deliveryId, {
        deliveryId: eligibleAction.deliveryId,
        partitionKey: eligibleAction.partitionKey,
        action: null,
        reason: "PARTITION_ALREADY_SELECTED",
        nextEligibleAt: null,
      });
      continue;
    }

    if (actions.length >= limit) {
      decisionByDeliveryId.set(eligibleAction.deliveryId, {
        deliveryId: eligibleAction.deliveryId,
        partitionKey: eligibleAction.partitionKey,
        action: null,
        reason: "BATCH_LIMIT",
        nextEligibleAt: null,
      });
      continue;
    }

    const {
      priority: _priority,
      queuedAt: _queuedAt,
      createdAt: _createdAt,
      ...action
    } = eligibleAction;

    actions.push(action);
    selectedPartitions.add(action.partitionKey);
    decisionByDeliveryId.set(action.deliveryId, {
      deliveryId: action.deliveryId,
      partitionKey: action.partitionKey,
      action: action.action,
      reason: null,
      nextEligibleAt: action.readyAt,
    });
  }

  const decisions = [...candidates]
    .sort((left, right) => compareText(left.id, right.id))
    .map((candidate) => decisionByDeliveryId.get(candidate.id)!);

  return {
    now,
    limit,
    inspectedCount: candidates.length,
    selectedCount: actions.length,
    actions,
    decisions,
  };
}
