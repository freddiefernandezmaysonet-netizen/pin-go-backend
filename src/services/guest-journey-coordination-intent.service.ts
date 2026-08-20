import { createHash } from "node:crypto";

import {
  GuestJourneyCoordinationIntentStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import type { AuditEntry } from "../apms/audit-types";
import {
  persistAuditEntry,
} from "../apms/audit-persistence.service";
import {
  GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
} from "./guest-journey-contract";
import type {
  CanonicalJourneyEvaluation,
  GuestJourneyCoordinationIntentSnapshot,
  ProposedJourneyCoordinationIntent,
} from "./guest-journey-contract";
import {
  buildGuestJourneyCoordinationIntentKeyFromProposal,
  normalizeGuestJourneyCoordinationPayload,
} from "./guest-journey-coordination-intent-key";
import {
  evaluateCanonicalGuestJourney,
} from "./guest-journey-evaluator";
import {
  loadGuestJourneyEvidence,
} from "./guest-journey-evidence.service";
import type {
  GuestJourneyEvidenceScope,
} from "./guest-journey-evidence.service";

const COORDINATION_LOCK_PREFIX =
  "GUEST_JOURNEY_COORDINATION:";

export type GuestJourneyCoordinationActionCode =
  | "NO_ACTION"
  | "JOURNEY_MISSING"
  | "CREATE_COORDINATION_INTENT"
  | "SUPERSEDE_OBSOLETE_INTENT"
  | "PRESERVE_ACTIVE_CLAIM"
  | "COMPARE_AND_SET_LOST";

export type GuestJourneyCoordinationAction = {
  code: GuestJourneyCoordinationActionCode;
  detail: string;
  intentKey?: string;
  intentType?: string;
  targetEngine?: string;
};

export type GuestJourneyCoordinationResult = {
  reservationId: string;
  journeyId: string | null;
  evaluation: CanonicalJourneyEvaluation;
  proposed: number;
  created: number;
  deduplicated: number;
  superseded: number;
  activeClaimsPreserved: number;
  compareAndSetLost: number;
  coordinationIntentWrites: number;
  operationalIssueWrites: 0;
  ownerEngineExecutions: 0;
  actions: GuestJourneyCoordinationAction[];
};

export type GuestJourneyCoordinationTransactionClient =
  Pick<
    Prisma.TransactionClient,
    | "reservation"
    | "guestJourneyCoordinationIntent"
    | "apmsAuditEntry"
  >;

type GuestJourneyCoordinationDependencies = {
  loadEvidence:
    typeof loadGuestJourneyEvidence;
  evaluate:
    typeof evaluateCanonicalGuestJourney;
  persistAudit:
    typeof persistAuditEntry;
};

const DEFAULT_DEPENDENCIES:
  GuestJourneyCoordinationDependencies = {
    loadEvidence:
      loadGuestJourneyEvidence,
    evaluate:
      evaluateCanonicalGuestJourney,
    persistAudit:
      persistAuditEntry,
  };

function requireReservationId(
  value: string
): string {
  const cleanValue = String(value ?? "").trim();

  if (!cleanValue) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_RESERVATION_ID_REQUIRED"
    );
  }

  return cleanValue;
}

function requireValidDate(
  value: Date
): Date {
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.getTime())
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_NOW_INVALID"
    );
  }

  return value;
}

function requireScope(
  scope: GuestJourneyEvidenceScope
): GuestJourneyEvidenceScope {
  const organizationId = String(
    scope.organizationId ?? ""
  ).trim();
  const propertyId = String(
    scope.propertyId ?? ""
  ).trim();

  if (!organizationId || !propertyId) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_SCOPE_REQUIRED"
    );
  }

  return {
    organizationId,
    propertyId,
  };
}

function intentPair(
  intent: Pick<
    ProposedJourneyCoordinationIntent,
    "intentType" | "targetEngine"
  >
): string {
  return [
    intent.intentType,
    intent.targetEngine,
  ].join(":");
}

function hasLiveClaim(
  intent:
    GuestJourneyCoordinationIntentSnapshot,
  now: Date
): boolean {
  if (
    intent.status !==
    GuestJourneyCoordinationIntentStatus
      .CLAIMED
  ) {
    return false;
  }

  return (
    !intent.leaseExpiresAt ||
    intent.leaseExpiresAt.getTime() >
      now.getTime()
  );
}

function buildAuditEntry(input: {
  evaluation: CanonicalJourneyEvaluation;
  organizationId: string;
  propertyId: string;
  now: Date;
  createdKeys: string[];
  supersededKeys: string[];
}): AuditEntry {
  const mutations = {
    createdKeys:
      [...input.createdKeys].sort(),
    supersededKeys:
      [...input.supersededKeys].sort(),
  };
  const mutationDigest = createHash("sha256")
    .update(JSON.stringify(mutations))
    .digest("hex");

  return {
    engine: "GUEST_JOURNEY",
    decisionId: [
      "guest-journey",
      "coordination-materialization",
      input.evaluation.reservationId,
      input.evaluation
        .evidenceFingerprint,
      mutationDigest,
    ].join(":"),
    entityType: "RESERVATION",
    entityId:
      input.evaluation.reservationId,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      `Guest Journey materialized ${input.createdKeys.length} and superseded ${input.supersededKeys.length} coordination intent(s).`,
    reason:
      "Canonical evidence required durable coordination with owner Engines; only the intent boundary was mutated.",
    startedAt: input.now,
    completedAt: input.now,
    durationMs: 0,
    decisions: [
      ...input.supersededKeys.map(
        (intentKey) => ({
          engine: "GUEST_JOURNEY" as const,
          rule:
            "SUPERSEDE_OBSOLETE_COORDINATION_INTENT",
          label:
            "Supersede obsolete coordination intent",
          previousValue: "ACTIVE",
          newValue: "SUPERSEDED",
          applied: true,
          metadata: {
            intentKey,
          },
        })
      ),
      ...input.createdKeys.map(
        (intentKey) => ({
          engine: "GUEST_JOURNEY" as const,
          rule:
            "MATERIALIZE_COORDINATION_INTENT",
          label:
            "Materialize owner Engine coordination intent",
          previousValue: null,
          newValue: "PENDING",
          applied: true,
          metadata: {
            intentKey,
          },
        })
      ),
    ],
    metadata: {
      runtime:
        "GUEST_JOURNEY_COORDINATION_INTENTS",
      coordinationIntentWritesEnabled:
        true,
      ownerEngineExecutionEnabled:
        false,
      operationalIssueWritesEnabled:
        false,
      organizationId:
        input.organizationId,
      propertyId: input.propertyId,
      reservationId:
        input.evaluation.reservationId,
      evidenceFingerprint:
        input.evaluation
          .evidenceFingerprint,
      evaluatorVersion:
        input.evaluation.contractVersion,
      intentContractVersion:
        GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
      ...mutations,
    },
  };
}

async function supersedeObsoleteIntent(
  tx:
    GuestJourneyCoordinationTransactionClient,
  intent:
    GuestJourneyCoordinationIntentSnapshot,
  now: Date
): Promise<boolean> {
  const result =
    await tx
      .guestJourneyCoordinationIntent
      .updateMany({
        where: {
          id: intent.id,
          status: intent.status,
          evidenceFingerprint:
            intent.evidenceFingerprint,
          ...(intent.status ===
          GuestJourneyCoordinationIntentStatus
            .CLAIMED
            ? {
                leaseExpiresAt: {
                  lte: now,
                },
              }
            : {}),
        },
        data: {
          status:
            GuestJourneyCoordinationIntentStatus
              .SUPERSEDED,
          supersededAt: now,
          leaseToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
          nextActionAt: null,
          lastError: null,
        },
      });

  return result.count === 1;
}

async function createIntent(
  tx:
    GuestJourneyCoordinationTransactionClient,
  input: {
    reservationId: string;
    journeyId: string;
    evaluation:
      CanonicalJourneyEvaluation;
    intent:
      ProposedJourneyCoordinationIntent;
    now: Date;
  }
): Promise<{
  created: boolean;
  intentKey: string;
}> {
  const intentKey =
    buildGuestJourneyCoordinationIntentKeyFromProposal(
      input.reservationId,
      input.evaluation
        .evidenceFingerprint,
      input.intent
    );
  const payload =
    normalizeGuestJourneyCoordinationPayload(
      input.intent.intentType,
      input.intent.payload
    );
  const result =
    await tx
      .guestJourneyCoordinationIntent
      .createMany({
        data: [
          {
            intentKey,
            reservationId:
              input.reservationId,
            journeyId: input.journeyId,
            contractVersion:
              GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
            intentType:
              input.intent.intentType,
            targetEngine:
              input.intent.targetEngine,
            reasonCode:
              input.intent.reasonCode,
            expectedOutcomeCode:
              input.intent
                .expectedOutcomeCode,
            evidenceFingerprint:
              input.evaluation
                .evidenceFingerprint,
            ...(payload
              ? {
                  payload,
                }
              : {}),
            status:
              GuestJourneyCoordinationIntentStatus
                .PENDING,
            nextActionAt: input.now,
          },
        ],
        skipDuplicates: true,
      });

  return {
    created: result.count === 1,
    intentKey,
  };
}

export async function materializeGuestJourneyCoordinationIntentsInTransaction(
  tx:
    GuestJourneyCoordinationTransactionClient,
  reservationId: string,
  now: Date,
  scope: GuestJourneyEvidenceScope,
  dependencies:
    GuestJourneyCoordinationDependencies =
      DEFAULT_DEPENDENCIES
): Promise<GuestJourneyCoordinationResult> {
  const cleanReservationId =
    requireReservationId(
      reservationId
    );
  const evaluatedAt = requireValidDate(now);
  const expectedScope =
    requireScope(scope);
  const evidence =
    await dependencies.loadEvidence(
      tx,
      cleanReservationId,
      evaluatedAt,
      expectedScope
    );
  const evaluation =
    dependencies.evaluate({
      ...evidence,
      activeIntents: [],
    });
  const actions:
    GuestJourneyCoordinationAction[] = [];
  const plannedIntents =
    evaluation.requiredCoordinationIntents
      .map((intent) => ({
        intent,
        intentKey:
          buildGuestJourneyCoordinationIntentKeyFromProposal(
            evidence.reservation.id,
            evaluation
              .evidenceFingerprint,
            intent
          ),
      }));
  const requiredIntentKeys = new Set(
    plannedIntents.map(
      (planned) => planned.intentKey
    )
  );

  if (
    !evidence.persistedJourney.exists ||
    !evidence.persistedJourney.id
  ) {
    actions.push({
      code: "JOURNEY_MISSING",
      detail:
        "E4 did not materialize coordination intents because the canonical Guest Journey is missing.",
    });

    return {
      reservationId:
        evidence.reservation.id,
      journeyId: null,
      evaluation,
      proposed:
        evaluation
          .requiredCoordinationIntents
          .length,
      created: 0,
      deduplicated: 0,
      superseded: 0,
      activeClaimsPreserved: 0,
      compareAndSetLost: 0,
      coordinationIntentWrites: 0,
      operationalIssueWrites: 0,
      ownerEngineExecutions: 0,
      actions,
    };
  }

  const blockedPairs = new Set<string>();
  const supersededKeys: string[] = [];
  let activeClaimsPreserved = 0;
  let compareAndSetLost = 0;

  for (const intent of evidence.activeIntents) {
    if (
      requiredIntentKeys.has(
        intent.intentKey
      )
    ) {
      continue;
    }

    if (hasLiveClaim(intent, evaluatedAt)) {
      blockedPairs.add(
        intentPair(intent)
      );
      activeClaimsPreserved += 1;
      actions.push({
        code: "PRESERVE_ACTIVE_CLAIM",
        detail:
          "E4 preserved an obsolete intent with a live owner Engine lease.",
        intentKey: intent.intentKey,
        intentType: intent.intentType,
        targetEngine:
          intent.targetEngine,
      });
      continue;
    }

    const superseded =
      await supersedeObsoleteIntent(
        tx,
        intent,
        evaluatedAt
      );

    if (superseded) {
      supersededKeys.push(
        intent.intentKey
      );
      actions.push({
        code:
          "SUPERSEDE_OBSOLETE_INTENT",
        detail:
          "E4 superseded an active coordination intent created from obsolete evidence.",
        intentKey: intent.intentKey,
        intentType: intent.intentType,
        targetEngine:
          intent.targetEngine,
      });
    } else {
      blockedPairs.add(
        intentPair(intent)
      );
      compareAndSetLost += 1;
      actions.push({
        code: "COMPARE_AND_SET_LOST",
        detail:
          "E4 preserved the winner after an intent changed concurrently.",
        intentKey: intent.intentKey,
        intentType: intent.intentType,
        targetEngine:
          intent.targetEngine,
      });
    }
  }

  const createdKeys: string[] = [];
  let deduplicated = 0;

  for (const planned of plannedIntents) {
    const intent = planned.intent;

    if (
      evidence.activeIntents.some(
        (activeIntent) =>
          activeIntent.intentKey ===
          planned.intentKey
      )
    ) {
      deduplicated += 1;
      continue;
    }

    if (blockedPairs.has(intentPair(intent))) {
      continue;
    }

    const materialized = await createIntent(
      tx,
      {
        reservationId:
          evidence.reservation.id,
        journeyId:
          evidence.persistedJourney.id,
        evaluation,
        intent,
        now: evaluatedAt,
      }
    );

    if (materialized.created) {
      createdKeys.push(
        materialized.intentKey
      );
      actions.push({
        code:
          "CREATE_COORDINATION_INTENT",
        detail:
          "E4 materialized a pending coordination intent without executing the owner Engine.",
        intentKey:
          materialized.intentKey,
        intentType: intent.intentType,
        targetEngine:
          intent.targetEngine,
      });
    } else {
      deduplicated += 1;
    }
  }

  if (
    createdKeys.length > 0 ||
    supersededKeys.length > 0
  ) {
    await dependencies.persistAudit(
      tx,
      buildAuditEntry({
        evaluation,
        organizationId:
          evidence.reservation
            .organizationId,
        propertyId:
          evidence.reservation
            .propertyId,
        now: evaluatedAt,
        createdKeys,
        supersededKeys,
      })
    );
  }

  if (actions.length === 0) {
    actions.push({
      code: "NO_ACTION",
      detail:
        "E4 found no coordination intent mutation required for the current evidence.",
    });
  }

  return {
    reservationId:
      evidence.reservation.id,
    journeyId:
      evidence.persistedJourney.id,
    evaluation,
    proposed:
      evaluation
        .requiredCoordinationIntents.length,
    created: createdKeys.length,
    deduplicated,
    superseded:
      supersededKeys.length,
    activeClaimsPreserved,
    compareAndSetLost,
    coordinationIntentWrites:
      createdKeys.length +
      supersededKeys.length,
    operationalIssueWrites: 0,
    ownerEngineExecutions: 0,
    actions,
  };
}

export async function materializeGuestJourneyCoordinationIntents(
  prisma: PrismaClient,
  reservationId: string,
  options: {
    now?: Date;
    scope: GuestJourneyEvidenceScope;
  }
): Promise<GuestJourneyCoordinationResult> {
  const cleanReservationId =
    requireReservationId(
      reservationId
    );
  const now = requireValidDate(
    options.now ?? new Date()
  );
  const scope = requireScope(
    options.scope
  );
  const advisoryLockKey =
    `${COORDINATION_LOCK_PREFIX}${cleanReservationId}`;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${advisoryLockKey}, 0)
          )
        `
      );

      return materializeGuestJourneyCoordinationIntentsInTransaction(
        tx,
        cleanReservationId,
        now,
        scope
      );
    }
  );
}
