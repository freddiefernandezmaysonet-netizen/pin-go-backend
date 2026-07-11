import type { UpsertOperationalIssueInput } from "./operational-intelligence.service";

export type ReservationCleaningOperationalInput = {
  organizationId: string | null;
  propertyId: string | null;
  reservationId: string;
  reservationNumber?: string | null;
  guestName?: string | null;

  cleaningConfirmationId?: string | null;
  cleaningConfirmationStatus?: string | null;
  staffMemberId?: string | null;
  cleanerName?: string | null;

  cleanerAccessReady: boolean;
  cleanerAccessAutopilotAttempted: boolean;
  cleanerAccessAutopilotOk?: boolean | null;
  cleanerAccessAutopilotReason?: string | null;
  cleanerAccessAutopilotError?: string | null;
  cleanerAccessAutopilotEscalated?: boolean | null;

  decisionId: string;
  sourceAuditEntryId: string;
  signalAt?: Date;
};

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeStatus(value: unknown) {
  return normalizeText(value).toUpperCase();
}

function buildSharedMetadata(
  input: ReservationCleaningOperationalInput
) {
  return {
    cleaningConfirmationId:
      normalizeText(input.cleaningConfirmationId) || null,
    cleaningConfirmationStatus:
      normalizeStatus(input.cleaningConfirmationStatus) || null,
    staffMemberId:
      normalizeText(input.staffMemberId) || null,
    cleanerAccessReady: input.cleanerAccessReady,
    cleanerAccessAutopilotAttempted:
      input.cleanerAccessAutopilotAttempted,
    cleanerAccessAutopilotOk:
      input.cleanerAccessAutopilotOk ?? null,
    cleanerAccessAutopilotReason:
      normalizeText(input.cleanerAccessAutopilotReason) || null,
    cleanerAccessAutopilotError:
      normalizeText(input.cleanerAccessAutopilotError) || null,
    cleanerAccessAutopilotEscalated:
      input.cleanerAccessAutopilotEscalated ?? null,
  };
}

function buildCleaningConfirmationOperationalItem(
  input: ReservationCleaningOperationalInput
): UpsertOperationalIssueInput | null {
  const confirmationId = normalizeText(
    input.cleaningConfirmationId
  );

  const confirmationStatus = normalizeStatus(
    input.cleaningConfirmationStatus
  );

  if (!confirmationId || !confirmationStatus) {
    return null;
  }

  const signalAt = input.signalAt ?? new Date();

  const sharedContext = {
    operationalKey:
      `CLEANING_CONFIRMATION:${confirmationId}`,

    engine: "Cleaning",

    organizationId: input.organizationId,
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    reservationNumber: input.reservationNumber ?? null,

    guestName: input.guestName ?? null,
    staffMemberId: input.staffMemberId ?? null,
    cleanerName: input.cleanerName ?? null,

    decisionId: input.decisionId,
    sourceAuditEntryId: input.sourceAuditEntryId,
    sourceType: "AUDIT_ENTRY" as const,

    firstDetectedAt: signalAt,
    lastSignalAt: signalAt,

    actionTarget: "CLEANING" as const,

    metadata: buildSharedMetadata(input),
  };

  if (confirmationStatus === "PENDING") {
    return {
      ...sharedContext,

      issueCode: "CLEANING_CONFIRMATION_PENDING",

      title: "Waiting for cleaner confirmation",

      issue:
        "The assigned cleaner has not confirmed availability for this turnover.",

      operationalImpact:
        "Cleaner access has not been created because confirmation is still pending.",

      recommendedAction:
        "No host action is required yet.",

      nextAutomaticStep:
        "When the cleaner confirms, Pin&Go will automatically create cleaner access and continue the turnover workflow.",

      severity: "INFO",
      workflowState: "WAITING",
      visibility: "HOST",
      responsibleActor: "CLEANER",

      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "AVAILABLE",
      autoResolveActionCode: null,

      resolutionCode: null,
      resolutionSummary: null,
      resolutionType: null,
      resolvedBy: null,
      resolvedAt: null,

      transitionCode:
        "CLEANING_CONFIRMATION_PENDING_DETECTED",

      transitionSummary:
        "Pin&Go is waiting for the assigned cleaner to confirm availability.",

      transitionedBy: "PIN_GO",
      occurredAt: signalAt,
    };
  }

  if (confirmationStatus === "DECLINED") {
    return {
      ...sharedContext,

      issueCode: "CLEANING_CONFIRMATION_DECLINED",

      title: "Cleaner declined the turnover",

      issue:
        "The assigned cleaner declined the cleaning confirmation.",

      operationalImpact:
        "The property currently has no confirmed cleaner for the turnover.",

      recommendedAction:
        "Assign a backup cleaner and verify confirmation.",

      nextAutomaticStep: null,

      severity: "WARNING",
      workflowState: "ACTION_REQUIRED",
      visibility: "HOST",
      responsibleActor: "HOST",

      actionRequired: true,
      canAutoResolve: false,
      autoResolveStatus: "NOT_SUPPORTED",
      autoResolveActionCode: null,

      resolutionCode: null,
      resolutionSummary: null,
      resolutionType: null,
      resolvedBy: null,
      resolvedAt: null,

      transitionCode:
        "CLEANING_CONFIRMATION_DECLINED",

      transitionSummary:
        "The assigned cleaner declined the turnover and host action is required.",

      transitionedBy: "CLEANER",
      occurredAt: signalAt,
    };
  }

  if (confirmationStatus === "CONFIRMED") {
    return {
      ...sharedContext,

      issueCode: "CLEANING_CONFIRMATION_CONFIRMED",

      title: "Cleaner confirmed the turnover",

      issue:
        "The assigned cleaner confirmed availability for this turnover.",

      operationalImpact:
        "The cleaning confirmation workflow is complete and Pin&Go can continue the turnover workflow.",

      recommendedAction:
        "No host action is required.",

      nextAutomaticStep:
        input.cleanerAccessReady
          ? "Pin&Go will continue monitoring the turnover workflow."
          : "Pin&Go will verify or create cleaner access automatically.",

      severity: "INFO",
      workflowState: "RESOLVED",
      visibility: "HOST",
      responsibleActor: "PIN_GO",

      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode: null,

      resolvedAt: signalAt,
      resolutionCode:
        "CLEANER_CONFIRMED_AVAILABILITY",
      resolutionSummary:
        "The cleaner confirmed availability and no host intervention was required.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "CLEANER",

      transitionCode:
        "CLEANING_CONFIRMATION_CONFIRMED",

      transitionSummary:
        "The cleaner confirmed availability and Pin&Go continued the turnover workflow.",

      transitionedBy: "CLEANER",
      occurredAt: signalAt,
    };
  }

  return null;
}

function buildCleanerAccessOperationalItem(
  input: ReservationCleaningOperationalInput
): UpsertOperationalIssueInput | null {
  const confirmationId = normalizeText(
    input.cleaningConfirmationId
  );

  const confirmationStatus = normalizeStatus(
    input.cleaningConfirmationStatus
  );

  if (
    !confirmationId ||
    confirmationStatus !== "CONFIRMED" ||
    !input.cleanerAccessAutopilotAttempted
  ) {
    return null;
  }

  const signalAt = input.signalAt ?? new Date();

  const sharedContext = {
    operationalKey:
      `CLEANER_ACCESS:${confirmationId}`,

    engine: "Access",

    organizationId: input.organizationId,
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    reservationNumber: input.reservationNumber ?? null,

    guestName: input.guestName ?? null,
    staffMemberId: input.staffMemberId ?? null,
    cleanerName: input.cleanerName ?? null,

    decisionId: input.decisionId,
    sourceAuditEntryId: input.sourceAuditEntryId,
    sourceType: "AUDIT_ENTRY" as const,

    firstDetectedAt: signalAt,
    lastSignalAt: signalAt,

    actionTarget: "ACCESS" as const,

    metadata: buildSharedMetadata(input),
  };

  if (
    input.cleanerAccessAutopilotOk === true &&
    input.cleanerAccessReady
  ) {
    return {
      ...sharedContext,

      issueCode: "CLEANER_ACCESS_CREATED",

      title: "Cleaner access created",

      issue:
        "Pin&Go created cleaner access after the cleaner confirmed availability.",

      operationalImpact:
        "The cleaner now has the scheduled access required for the turnover.",

      recommendedAction:
        "No host action is required.",

      nextAutomaticStep:
        "Pin&Go will continue monitoring the cleaner access lifecycle.",

      severity: "INFO",
      workflowState: "RESOLVED",
      visibility: "HOST",
      responsibleActor: "PIN_GO",

      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode:
        "CREATE_CLEANER_NFC_ACCESS",

      resolvedAt: signalAt,
      resolutionCode:
        "CLEANER_ACCESS_CREATED_AUTOMATICALLY",
      resolutionSummary:
        "Pin&Go created cleaner access automatically after confirmation.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",

      transitionCode:
        "CLEANER_ACCESS_CREATED",

      transitionSummary:
        "Access Autopilot created cleaner access without host intervention.",

      transitionedBy: "PIN_GO",
      occurredAt: signalAt,
    };
  }

  if (input.cleanerAccessAutopilotOk === false) {
    return {
      ...sharedContext,

      issueCode: "CLEANER_ACCESS_CREATION_FAILED",

      title: "Cleaner access could not be created",

      issue:
        "The cleaner confirmed availability, but Pin&Go could not create cleaner access.",

      operationalImpact:
        "The confirmed cleaner does not currently have the scheduled access required for the turnover.",

      recommendedAction:
        "Review the cleaner NFC card, TTLock mapping and active property lock.",

      nextAutomaticStep: null,

      severity:
        input.cleanerAccessAutopilotEscalated
          ? "CRITICAL"
          : "WARNING",

      workflowState: "ACTION_REQUIRED",
      visibility: "HOST",
      responsibleActor: "HOST",

      actionRequired: true,
      canAutoResolve: false,
      autoResolveStatus: "NOT_SUPPORTED",
      autoResolveActionCode: null,

      resolvedAt: null,
      resolutionCode: null,
      resolutionSummary: null,
      resolutionType: null,
      resolvedBy: null,

      transitionCode:
        "CLEANER_ACCESS_CREATION_FAILED",

      transitionSummary:
        "Access Autopilot could not create cleaner access and escalated the operational issue.",

      transitionedBy: "PIN_GO",
      occurredAt: signalAt,
    };
  }

  return null;
}

export function mapReservationCleaningOperationalItems(
  input: ReservationCleaningOperationalInput
): UpsertOperationalIssueInput[] {
  const items: UpsertOperationalIssueInput[] = [];

  const cleaningConfirmationItem =
    buildCleaningConfirmationOperationalItem(input);

  if (cleaningConfirmationItem) {
    items.push(cleaningConfirmationItem);
  }

  const cleanerAccessItem =
    buildCleanerAccessOperationalItem(input);

  if (cleanerAccessItem) {
    items.push(cleanerAccessItem);
  }

  return items;
}