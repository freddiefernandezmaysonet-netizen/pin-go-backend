import {
  DamageCaseGuestResponse,
  DamageCaseStatus,
  PrismaClient,
} from "@prisma/client";

import {
  ApmsOperationalReopenSourceNotResolvedError,
  reopenOperationalIssue,
  upsertOperationalIssue,
  type UpsertOperationalIssueInput,
} from "../apms/operational-intelligence.service.js";

export const PROPERTY_PROTECTION_OPERATIONAL_ISSUE_CODE =
  "PROPERTY_PROTECTION_DAMAGE_CASE";

export type DamageCaseMissionControlSource = {
  id: string;
  status: DamageCaseStatus;
  guestResponse: DamageCaseGuestResponse;
  createdAt: Date;
  updatedAt: Date;
  guestNotifiedAt: Date | null;
  reservationId: string;
  reservation: {
    reservationNumber: string | null;
    guestName: string | null;
    propertyId: string;
    property: {
      organizationId: string;
    };
  };
  damageNoticeDelivery: {
    status: string;
    retryCount: number;
  } | null;
  closureNoticeDelivery: {
    status: string;
    retryCount: number;
  } | null;
};

type ProjectionState = Pick<
  UpsertOperationalIssueInput,
  | "title"
  | "issue"
  | "operationalImpact"
  | "recommendedAction"
  | "nextAutomaticStep"
  | "severity"
  | "workflowState"
  | "responsibleActor"
  | "actionRequired"
  | "canAutoResolve"
  | "autoResolveStatus"
  | "resolutionCode"
  | "resolutionSummary"
  | "resolutionType"
  | "resolvedBy"
>;

function actionRequired(
  title: string,
  issue: string,
  recommendedAction: string,
  severity: "INFO" | "WARNING" = "INFO"
): ProjectionState {
  return {
    title,
    issue,
    operationalImpact:
      "The Property Protection case cannot advance until the required review is completed.",
    recommendedAction,
    nextAutomaticStep: null,
    severity,
    workflowState: "ACTION_REQUIRED",
    responsibleActor: "HOST",
    actionRequired: true,
    canAutoResolve: false,
    autoResolveStatus: "NOT_SUPPORTED",
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
  };
}

function waiting(
  title: string,
  issue: string,
  nextAutomaticStep: string
): ProjectionState {
  return {
    title,
    issue,
    operationalImpact:
      "No host action is required while the Property Protection workflow waits for its next canonical event.",
    recommendedAction: null,
    nextAutomaticStep,
    severity: "INFO",
    workflowState: "WAITING",
    responsibleActor: "GUEST",
    actionRequired: false,
    canAutoResolve: false,
    autoResolveStatus: "NOT_SUPPORTED",
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
  };
}

export function projectDamageCaseToMissionControl(input: {
  damageCase: DamageCaseMissionControlSource;
  maxMessageRetries: number;
}): UpsertOperationalIssueInput {
  const damageCase = input.damageCase;
  const reservation = damageCase.reservation.reservationNumber
    ? `reservation ${damageCase.reservation.reservationNumber}`
    : "the reservation";
  let state: ProjectionState;

  if (damageCase.status === DamageCaseStatus.EVIDENCE_PENDING) {
    state = actionRequired(
      "Property Protection evidence is required",
      `The damage case for ${reservation} does not yet include evidence.`,
      "Add the supporting evidence and submit the case for host review."
    );
  } else if (damageCase.status === DamageCaseStatus.OPEN) {
    state = actionRequired(
      "Property Protection case is ready for review",
      `The damage case for ${reservation} has been documented but has not been submitted for review.`,
      "Review the case details and submit it for host review."
    );
  } else if (damageCase.status === DamageCaseStatus.HOST_REVIEW) {
    state = actionRequired(
      "Property Protection case awaits host decision",
      `The documented damage case for ${reservation} is awaiting host approval or no-charge closure.`,
      "Review the evidence, then approve the guest notice or close the case without charge."
    );
  } else if (
    damageCase.status === DamageCaseStatus.GUEST_NOTIFICATION_PENDING
  ) {
    const delivery = damageCase.damageNoticeDelivery;
    const retryExhausted =
      !delivery ||
      delivery.status === "FAILED_FINAL" ||
      (delivery.status === "FAILED" &&
        delivery.retryCount >= input.maxMessageRetries);

    state = retryExhausted
      ? actionRequired(
          "Property Protection guest notice needs attention",
          `Pin&Go could not deliver the Property Protection update for ${reservation}. No charge was made.`,
          "Verify the guest email destination and contact Pin&Go support before continuing.",
          "WARNING"
        )
      : {
          title: "Pin&Go is delivering the Property Protection update",
          issue: `The approved damage case for ${reservation} is pending guest notification.`,
          operationalImpact:
            "The case remains protected and no charge has been made while delivery is retried.",
          recommendedAction: null,
          nextAutomaticStep:
            "Pin&Go will retry the brief guest notice automatically and record delivery before advancing the case.",
          severity: "INFO",
          workflowState: "AUTO_RESOLVING",
          responsibleActor: "PIN_GO",
          actionRequired: false,
          canAutoResolve: true,
          autoResolveStatus: "AVAILABLE",
          resolutionCode: null,
          resolutionSummary: null,
          resolutionType: null,
          resolvedBy: null,
        };
  } else if (damageCase.status === DamageCaseStatus.GUEST_NOTIFIED) {
    if (damageCase.guestResponse === DamageCaseGuestResponse.DISPUTED) {
      state = actionRequired(
        "Guest disputed the Property Protection case",
        `The guest disputed the damage case for ${reservation}. No charge was made.`,
        "Review the guest response and close the case without charge when the review is complete.",
        "WARNING"
      );
    } else if (damageCase.guestResponse === DamageCaseGuestResponse.ACCEPTED) {
      state = waiting(
        "Guest accepted the Property Protection case",
        `The guest accepted the damage case for ${reservation}. No charge has been made and financial processing is not enabled.`,
        "The case will remain non-charging until a host closes it without charge or a separately authorized financial phase is introduced."
      );
    } else if (
      damageCase.guestResponse === DamageCaseGuestResponse.ACKNOWLEDGED
    ) {
      state = waiting(
        "Guest acknowledged the Property Protection update",
        `The guest viewed the damage case for ${reservation} but has not submitted a final response.`,
        "Pin&Go is waiting for the guest to accept or dispute the case in Manage Reservation."
      );
    } else {
      state = waiting(
        "Waiting for the guest Property Protection response",
        `The guest notice for ${reservation} was delivered and the case is awaiting a response.`,
        "Pin&Go is waiting for the guest to review the case in Manage Reservation."
      );
    }
  } else if (damageCase.status === DamageCaseStatus.CLOSED_NO_CHARGE) {
    const delivery = damageCase.closureNoticeDelivery;
    const closureNoticeRequired = Boolean(damageCase.guestNotifiedAt);
    const retryActive =
      delivery?.status === "FAILED" &&
      delivery.retryCount < input.maxMessageRetries;

    if (!closureNoticeRequired || delivery?.status === "SENT") {
      state = {
        title: "Property Protection case closed without charge",
        issue: `The damage case for ${reservation} was closed without charging the guest.`,
        operationalImpact:
          "The non-charging Property Protection workflow is complete.",
        recommendedAction: null,
        nextAutomaticStep: null,
        severity: "INFO",
        workflowState: "RESOLVED",
        responsibleActor: "NONE",
        actionRequired: false,
        canAutoResolve: false,
        autoResolveStatus: "NOT_SUPPORTED",
        resolutionCode: "PROPERTY_PROTECTION_CLOSED_NO_CHARGE",
        resolutionSummary:
          "The host closed the Property Protection case without a guest charge.",
        resolutionType: "MANUAL",
        resolvedBy: "HOST",
      };
    } else if (retryActive) {
      state = {
        title: "Pin&Go is delivering the Property Protection closure",
        issue: `The damage case for ${reservation} is closed without charge and its guest closure notice is pending retry.`,
        operationalImpact:
          "The case remains closed without charge while Pin&Go retries the guest closure notice.",
        recommendedAction: null,
        nextAutomaticStep:
          "Pin&Go will retry the brief guest closure notice automatically and record delivery.",
        severity: "INFO",
        workflowState: "AUTO_RESOLVING",
        responsibleActor: "PIN_GO",
        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "AVAILABLE",
        resolutionCode: null,
        resolutionSummary: null,
        resolutionType: null,
        resolvedBy: null,
      };
    } else {
      state = {
        title: "Property Protection closure notice needs attention",
        issue: `Pin&Go could not confirm delivery of the closure notice for ${reservation}. The case remains closed and no charge was made.`,
        operationalImpact:
          "The Damage Case is closed without charge, but guest closure communication is incomplete.",
        recommendedAction:
          "Verify the guest email destination and contact Pin&Go support before considering the communication complete.",
        nextAutomaticStep: null,
        severity: "WARNING",
        workflowState: "ACTION_REQUIRED",
        responsibleActor: "HOST",
        actionRequired: true,
        canAutoResolve: false,
        autoResolveStatus: "NOT_SUPPORTED",
        resolutionCode: null,
        resolutionSummary: null,
        resolutionType: null,
        resolvedBy: null,
      };
    }
  } else {
    state = actionRequired(
      "Property Protection case is financially blocked",
      `The damage case for ${reservation} is in a protected financial-block state. No charge was made.`,
      "Review the case before any separately authorized financial workflow is considered.",
      "WARNING"
    );
  }

  return {
    operationalKey: `PROPERTY_PROTECTION_DAMAGE_CASE:${damageCase.id}`,
    issueCode: PROPERTY_PROTECTION_OPERATIONAL_ISSUE_CODE,
    ...state,
    engine: "PROPERTY_PROTECTION",
    visibility: "HOST",
    autoResolveActionCode: null,
    organizationId: damageCase.reservation.property.organizationId,
    propertyId: damageCase.reservation.propertyId,
    reservationId: damageCase.reservationId,
    reservationNumber: damageCase.reservation.reservationNumber,
    guestName: damageCase.reservation.guestName,
    sourceType: "ENGINE_EVENT",
    firstDetectedAt: damageCase.createdAt,
    lastSignalAt: damageCase.updatedAt,
    resolvedAt:
      state.workflowState === "RESOLVED" ? damageCase.updatedAt : null,
    actionTarget: "RESERVATION",
    metadata: {
      damageCaseStatus: damageCase.status,
      guestResponse: damageCase.guestResponse,
      damageNoticeDeliveryStatus:
        damageCase.damageNoticeDelivery?.status ?? null,
      damageNoticeRetryCount:
        damageCase.damageNoticeDelivery?.retryCount ?? null,
      closureNoticeRequired: Boolean(damageCase.guestNotifiedAt),
      closureNoticeDeliveryStatus:
        damageCase.closureNoticeDelivery?.status ?? null,
      closureNoticeRetryCount:
        damageCase.closureNoticeDelivery?.retryCount ?? null,
    },
    transitionCode: `PROPERTY_PROTECTION_${damageCase.status}_${damageCase.guestResponse}`,
    transitionSummary:
      "Property Protection projected the canonical Damage Case state to Mission Control.",
    transitionedBy:
      state.responsibleActor === "HOST" ? "HOST" : "PIN_GO",
    occurredAt: damageCase.updatedAt,
  };
}

export async function syncDamageCaseMissionControl(input: {
  prisma: PrismaClient;
  damageCaseId: string;
  maxMessageRetries?: number;
}) {
  const damageCase = await input.prisma.damageCase.findUnique({
    where: { id: input.damageCaseId },
    include: {
      reservation: {
        select: {
          reservationNumber: true,
          guestName: true,
          propertyId: true,
          property: {
            select: { organizationId: true },
          },
        },
      },
    },
  });

  if (!damageCase) {
    return { ok: false as const, code: "DAMAGE_CASE_NOT_FOUND" as const };
  }

  const damageNoticeDelivery = await input.prisma.messageLog.findFirst({
    where: {
      reservationId: damageCase.reservationId,
      communicationType: "PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE",
      channel: "email",
    },
    orderBy: { createdAt: "desc" },
    select: { status: true, retryCount: true },
  });

  const closureNoticeDelivery = await input.prisma.messageLog.findFirst({
    where: {
      reservationId: damageCase.reservationId,
      communicationType:
        "PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE",
      channel: "email",
    },
    orderBy: { createdAt: "desc" },
    select: { status: true, retryCount: true },
  });

  const projection = projectDamageCaseToMissionControl({
    damageCase: {
      ...damageCase,
      damageNoticeDelivery,
      closureNoticeDelivery,
    },
    maxMessageRetries:
      input.maxMessageRetries ??
      Number(process.env.MESSAGE_MAX_RETRIES ?? 3),
  });

  if (
    damageCase.status === DamageCaseStatus.CLOSED_NO_CHARGE &&
    damageCase.guestNotifiedAt
  ) {
    const deliveryObservedAt = new Date();
    projection.lastSignalAt = deliveryObservedAt;
    projection.occurredAt = deliveryObservedAt;
    projection.resolvedAt =
      projection.workflowState === "RESOLVED"
        ? deliveryObservedAt
        : null;
  }

  const currentIssue = await input.prisma.operationalIssue.findUnique({
    where: { operationalKey: projection.operationalKey },
    select: { workflowState: true },
  });

  if (
    currentIssue?.workflowState === "RESOLVED" &&
    projection.workflowState !== "RESOLVED"
  ) {
    try {
      await reopenOperationalIssue(input.prisma, {
        operationalKey: projection.operationalKey,
        workflowState: projection.workflowState,
        severity: projection.severity,
        responsibleActor: projection.responsibleActor,
        actionRequired: projection.actionRequired,
        recommendedAction: projection.recommendedAction,
        nextAutomaticStep: projection.nextAutomaticStep,
        canAutoResolve: projection.canAutoResolve,
        autoResolveStatus: projection.autoResolveStatus,
        autoResolveActionCode: projection.autoResolveActionCode,
        reopenCode:
          "PROPERTY_PROTECTION_CLOSURE_DELIVERY_INCOMPLETE",
        reopenSummary:
          "Property Protection reopened the operational projection because required guest closure delivery is incomplete.",
        reopenedBy: "PIN_GO",
        sourceType: projection.sourceType,
        occurredAt: projection.occurredAt,
        metadata: projection.metadata as Record<string, unknown>,
      });
    } catch (error) {
      if (!(error instanceof ApmsOperationalReopenSourceNotResolvedError)) {
        throw error;
      }
    }
  }

  const operationalIssue = await upsertOperationalIssue(
    input.prisma,
    projection
  );

  return { ok: true as const, operationalIssue };
}

export async function syncDamageCaseMissionControlSafely(input: {
  prisma: PrismaClient;
  damageCaseId: string;
  maxMessageRetries?: number;
}) {
  try {
    return await syncDamageCaseMissionControl(input);
  } catch (error) {
    console.error("Property Protection Mission Control sync failed", {
      damageCaseId: input.damageCaseId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false as const,
      code: "PROPERTY_PROTECTION_MISSION_CONTROL_SYNC_FAILED" as const,
    };
  }
}
