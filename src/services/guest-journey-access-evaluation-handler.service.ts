import {
  GuestAccessReleaseStatus,
  PrismaClient,
} from "@prisma/client";

import {
  GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE,
} from "./guest-journey-contract";
import {
  evaluateCanonicalGuestJourney,
} from "./guest-journey-evaluator";
import {
  loadGuestJourneyEvidence,
} from "./guest-journey-evidence.service";
import {
  evaluateGuestAccessReadiness,
} from "./guest-access-readiness.service";
import type {
  AccessEvaluationCompletion,
  ClaimedAccessEvaluationIntent,
} from "./guest-journey-owner-runtime.service";

type AccessEvaluationHandlerDependencies = {
  evaluateReadiness:
    typeof evaluateGuestAccessReadiness;
  loadEvidence:
    typeof loadGuestJourneyEvidence;
  evaluateJourney:
    typeof evaluateCanonicalGuestJourney;
};

const DEFAULT_DEPENDENCIES:
  AccessEvaluationHandlerDependencies = {
    evaluateReadiness:
      evaluateGuestAccessReadiness,
    loadEvidence:
      loadGuestJourneyEvidence,
    evaluateJourney:
      evaluateCanonicalGuestJourney,
  };

export type GuestJourneyAccessEvaluationHandlerResult = {
  handlerCode:
    typeof GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE;
  externalSideEffects: 0;
  completion:
    AccessEvaluationCompletion;
};

function requireValidDate(
  value: Date
): Date {
  const now = new Date(value);

  if (Number.isNaN(now.getTime())) {
    throw new Error(
      "GUEST_JOURNEY_ACCESS_EVALUATION_NOW_INVALID"
    );
  }

  return now;
}

export async function executeGuestJourneyAccessEvaluationHandler(
  prisma: PrismaClient,
  claim: ClaimedAccessEvaluationIntent,
  options: {
    now?: Date;
  } = {},
  dependencies:
    AccessEvaluationHandlerDependencies =
      DEFAULT_DEPENDENCIES
): Promise<GuestJourneyAccessEvaluationHandlerResult> {
  const now = requireValidDate(
    options.now ?? new Date()
  );

  if (
    claim.targetEngine !== "ACCESS" ||
    claim.intentType !==
      "REQUEST_ACCESS_EVALUATION" ||
    claim.expectedOutcomeCode !==
      "ACCESS_RELEASE_STATUS_ELIGIBLE"
  ) {
    throw new Error(
      "GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CONTRACT_MISMATCH"
    );
  }

  const readiness =
    await dependencies.evaluateReadiness(
      prisma,
      claim.reservationId,
      {
        persist: true,
        now,
        expectedScope: {
          organizationId:
            claim.organizationId,
          propertyId:
            claim.propertyId,
        },
      }
    );
  const evidence =
    await dependencies.loadEvidence(
      prisma,
      claim.reservationId,
      now,
      {
        organizationId:
          claim.organizationId,
        propertyId:
          claim.propertyId,
      }
    );
  const evaluation =
    dependencies.evaluateJourney({
      ...evidence,

      // The claimed intent is input, never proof of its own outcome.
      activeIntents: [],
    });
  const outcomeSatisfied =
    readiness.ready &&
    (
      readiness.releaseStatus ===
        GuestAccessReleaseStatus.ELIGIBLE ||
      readiness.releaseStatus ===
        GuestAccessReleaseStatus.RELEASED
    ) &&
    evaluation.outcomeEvidence
      .accessEligibilitySatisfied;

  if (outcomeSatisfied) {
    return {
      handlerCode:
        GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE,
      externalSideEffects: 0,
      completion: {
        kind: "SUCCEEDED",
        outcomeEvidenceFingerprint:
          evaluation
            .evidenceFingerprint,
      },
    };
  }

  const blockers = [
    ...readiness.blockers,
  ].sort();

  return {
    handlerCode:
      GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE,
    externalSideEffects: 0,
    completion: {
      kind:
        "WAITING_FOR_EVIDENCE",
      outcomeEvidenceFingerprint:
        evaluation.evidenceFingerprint,
      errorCode:
        "ACCESS_EVIDENCE_PENDING",
      errorDetail:
        blockers.length > 0
          ? blockers.join(",")
          : "Canonical ACCESS eligibility evidence is not satisfied.",
    },
  };
}
