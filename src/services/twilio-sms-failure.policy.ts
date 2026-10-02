/**
 * Pure decision boundary for a correlated Twilio SMS delivery failure.
 *
 * This module performs no I/O. Callers must authenticate the callback and load
 * current, tenant-scoped persistence before evaluating it. A 30005 receipt is
 * evidence about one delivery attempt, not proof that a phone is permanently
 * invalid. No decision here authorizes a message, fallback, or reservation edit.
 */
export type SmsDeliveryEvidence = {
  messageLogId: string;
  providerMessageId: string | null;
  provider: string;
  channel: string;
  communicationType: string | null;
  sendAttemptStatus: string | null;
  providerDeliveryStatus: string | null;
  providerErrorCode: string | null;
  organizationId: string | null;
  propertyId: string | null;
  reservationId: string | null;
};

export type SmsReservationEvidence = {
  id: string;
  organizationId: string;
  propertyId: string;
  status: string;
  cancelledAt: Date | null;
  checkIn: Date;
  checkOut: Date;
};

export type ExistingSmsFailureIssue = {
  operationalKey: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  workflowState: string;
};

/** Trusted, current recovery snapshot; never populate it from callback fields.
 * retriesUsed belongs to the logical message and survives a new provider SID.
 * Claim the one retry durably before provider I/O; uncertain outcomes consume it.
 * Times are explicit policy inputs, not a hard-coded property-local schedule.
 */
export type SmsRetryEvidence = {
  messageLogId: string;
  providerMessageId: string;
  retriesUsed: number;
  retryState: "AVAILABLE" | "CLAIMED" | "OUTCOME_UNKNOWN";
  firstFailureAt: Date;
  retryNotBefore: Date;
  contentValidUntil: Date;
  currentRecipientAndContent: boolean;
  minimumSpacingMs: number;
  /** Only the next independently eligible scheduled communication, or null. */
  nextScheduledMessage: {
    messageKey: string;
    organizationId: string;
    propertyId: string;
    reservationId: string;
    scheduledAt: Date;
  } | null;
};

export type SmsRetryPlan = {
  /** Stable across callbacks and new provider SIDs: only retry ordinal 1. */
  recoveryKey: string;
  failedProviderMessageId: string;
  retryOrdinal: 1;
  notBefore: Date;
  validUntil: Date;
};

export type SmsFailureHostAction = {
  operationalKey: string;
  issueCode: "GUEST_SMS_UNKNOWN_DESTINATION";
  title: string;
  issue: string;
  operationalImpact: string;
  recommendedAction: string;
  nextAutomaticStep: null;
  engine: "COMMUNICATIONS";
  severity: "WARNING" | "CRITICAL";
  workflowState: "ACTION_REQUIRED";
  visibility: "HOST";
  responsibleActor: "HOST";
  actionRequired: true;
  canAutoResolve: false;
  autoResolveStatus: "NOT_SUPPORTED";
  autoResolveActionCode: null;
  actionTarget: "RESERVATION";
  sourceType: "ENGINE_EVENT";
  organizationId: string;
  propertyId: string;
  reservationId: string;
  transitionCode: "GUEST_SMS_DELIVERY_FAILED";
  transitionSummary: string;
  transitionedBy: "PIN_GO";
  occurredAt: Date;
  metadata: {
    version: "TWILIO_SMS_FAILURE_V1";
    provider: "twilio";
    messageLogId: string;
    providerMessageId: string;
    providerDeliveryStatus: "UNDELIVERED" | "FAILED";
    providerErrorCode: "30005";
    communicationType: "PRECHECKIN" | "GUEST_ACCESS_PASSCODE";
    automatedSameMessageReplay: "BUDGET_EXHAUSTED_OR_UNSAFE";
  };
};

export type SmsFailureDecision = {
  kind: "NO_ACTION" | "REVIEW_EVIDENCE" | "HOST_ACTION_REQUIRED" |
    "WAIT_FOR_RETRY" | "RETRY_ELIGIBLE" | "WAIT_FOR_NEXT_MESSAGE";
  reason: string;
  deliveryConfirmed: boolean;
  /** This is never an authorization to send. Other policies still apply. */
  blockAutomaticReplay: boolean;
  /** This failed attempt never suppresses a separate scheduled communication.
   * The separate send must still pass its own consent/access/expiry checks.
   */
  blockOtherScheduledMessages: false;
  retryPlan: SmsRetryPlan | null;
  /** Never silently reopen a manually or automatically resolved issue. */
  hostAction: SmsFailureHostAction | null;
};

function clean(value: string | null): string {
  return (value ?? "").trim();
}

function isId(value: string | null): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function decision(
  kind: SmsFailureDecision["kind"],
  reason: string,
  blockAutomaticReplay: boolean,
  deliveryConfirmed = false
): SmsFailureDecision {
  return { kind, reason, deliveryConfirmed, blockAutomaticReplay,
    blockOtherScheduledMessages: false, retryPlan: null, hostAction: null };
}

export function smsFailureOperationalKey(
  messageLogId: string,
  providerMessageId: string
): string {
  if (!isId(messageLogId) || !/^SM[0-9a-fA-F]{32}$/.test(providerMessageId)) {
    throw new Error("SMS_FAILURE_INVALID_CORRELATION");
  }
  // Each attempt has its own identity; an old receipt must not target a new SID.
  return `GUEST_SMS_DELIVERY:${messageLogId}:${providerMessageId}`;
}

export function evaluateTwilioSmsFailure(input: {
  message: SmsDeliveryEvidence;
  reservation: SmsReservationEvidence | null;
  existingIssue?: ExistingSmsFailureIssue | null;
  recovery?: SmsRetryEvidence | null;
  now: Date;
}): SmsFailureDecision {
  const { message, reservation, now } = input;
  if (message.provider !== "twilio" || message.channel !== "sms") {
    return decision("NO_ACTION", "OUT_OF_SCOPE_PROVIDER_OR_CHANNEL", false);
  }

  const status = clean(message.providerDeliveryStatus).toUpperCase();
  const code = clean(message.providerErrorCode);
  const delivered = status === "DELIVERED" || status === "READ";
  const failed = status === "UNDELIVERED" || status === "FAILED";

  if (code === "30005" && !failed) {
    return decision("REVIEW_EVIDENCE", "CONTRADICTORY_PROVIDER_EVIDENCE", true);
  }
  if (delivered) return decision("NO_ACTION", "PROVIDER_DELIVERY_CONFIRMED", true, true);
  if (code !== "30005" || !failed) {
    return decision("NO_ACTION", "NO_30005_DELIVERY_FAILURE", false);
  }

  // Local SENT/FAILED is intentionally not used as evidence of delivery.
  if (!isId(message.messageLogId) ||
      !/^SM[0-9a-fA-F]{32}$/.test(message.providerMessageId ?? "")) {
    return decision("REVIEW_EVIDENCE", "MESSAGE_CORRELATION_MISSING", true);
  }
  if (!validDate(now)) return decision("REVIEW_EVIDENCE", "INVALID_NOW", true);
  if (!reservation ||
      !isId(message.organizationId) || !isId(message.propertyId) || !isId(message.reservationId) ||
      !isId(reservation.id) || !isId(reservation.organizationId) || !isId(reservation.propertyId) ||
      message.reservationId !== reservation.id ||
      message.propertyId !== reservation.propertyId ||
      message.organizationId !== reservation.organizationId) {
    return decision("REVIEW_EVIDENCE", "RESERVATION_SCOPE_MISMATCH", true);
  }
  if (reservation.status === "CANCELLED" || reservation.cancelledAt !== null) {
    return decision("NO_ACTION", "RESERVATION_CANCELLED", true);
  }
  if (reservation.status !== "ACTIVE") {
    return decision("REVIEW_EVIDENCE", "RESERVATION_STATE_UNSUPPORTED", true);
  }
  if (!validDate(reservation.checkIn) || !validDate(reservation.checkOut) ||
      reservation.checkOut <= reservation.checkIn) {
    return decision("REVIEW_EVIDENCE", "RESERVATION_DATES_INVALID", true);
  }
  if (now >= reservation.checkOut) {
    return decision("NO_ACTION", "STAY_ENDED", true);
  }

  const type = message.communicationType;
  if (type !== "PRECHECKIN" && type !== "GUEST_ACCESS_PASSCODE") {
    return decision("NO_ACTION", "COMMUNICATION_TYPE_OUT_OF_SCOPE", true);
  }
  const sid = message.providerMessageId!;
  const operationalKey = smsFailureOperationalKey(message.messageLogId, sid);
  const existingIssue = input.existingIssue;
  if (existingIssue) {
    if (existingIssue.operationalKey !== operationalKey ||
        existingIssue.reservationId !== reservation.id ||
        existingIssue.propertyId !== reservation.propertyId ||
        existingIssue.organizationId !== reservation.organizationId) {
      return decision("REVIEW_EVIDENCE", "EXISTING_ISSUE_SCOPE_MISMATCH", true);
    }
    if (existingIssue.workflowState === "RESOLVED") {
      return decision("NO_ACTION", "EXISTING_ISSUE_RESOLVED", true);
    }
    if (["ACTION_REQUIRED", "WAITING", "AUTO_RESOLVING"].includes(existingIssue.workflowState)) {
      return decision("NO_ACTION", "EXISTING_ISSUE_OWNS_RECOVERY", true);
    }
    return decision("REVIEW_EVIDENCE", "EXISTING_ISSUE_STATE_UNSUPPORTED", true);
  }

  const recovery = input.recovery;
  if (!recovery) {
    return decision("REVIEW_EVIDENCE", "RETRY_EVIDENCE_MISSING", true);
  }
  if (recovery.messageLogId !== message.messageLogId || recovery.providerMessageId !== sid) {
    return decision("REVIEW_EVIDENCE", "RETRY_CORRELATION_MISMATCH", true);
  }
  if (!Number.isSafeInteger(recovery.retriesUsed) || recovery.retriesUsed < 0 ||
      !["AVAILABLE", "CLAIMED", "OUTCOME_UNKNOWN"].includes(recovery.retryState) ||
      !validDate(recovery.firstFailureAt) || recovery.firstFailureAt > now ||
      !validDate(recovery.retryNotBefore) || recovery.retryNotBefore <= recovery.firstFailureAt ||
      !validDate(recovery.contentValidUntil) ||
      !Number.isSafeInteger(recovery.minimumSpacingMs) ||
      recovery.minimumSpacingMs < 60_000 || recovery.minimumSpacingMs > 3_600_000) {
    return decision("REVIEW_EVIDENCE", "RETRY_EVIDENCE_INVALID", true);
  }
  if (recovery.currentRecipientAndContent !== true) {
    return decision("REVIEW_EVIDENCE", "RECIPIENT_OR_CONTENT_CHANGED", true);
  }
  if (recovery.retryState !== "AVAILABLE") {
    return decision("REVIEW_EVIDENCE", "RETRY_ALREADY_CLAIMED_OR_OUTCOME_UNKNOWN", true);
  }

  // No replay after the current content/access window or the relevant stay boundary.
  const validUntil = new Date(Math.min(recovery.contentValidUntil.getTime(),
    (type === "PRECHECKIN" ? reservation.checkIn : reservation.checkOut).getTime()));
  if (now >= validUntil) return decision("NO_ACTION", "MESSAGE_EXPIRED", true);

  const next = recovery.nextScheduledMessage;
  if (next && (!isId(next.messageKey) || next.messageKey === message.messageLogId ||
      next.organizationId !== reservation.organizationId ||
      next.propertyId !== reservation.propertyId || next.reservationId !== reservation.id ||
      !validDate(next.scheduledAt) || next.scheduledAt <= recovery.firstFailureAt)) {
    return decision("REVIEW_EVIDENCE", "NEXT_MESSAGE_SCOPE_OR_TIME_INVALID", true);
  }

  let hostReason = "SAME_MESSAGE_RETRY_EXHAUSTED";
  if (recovery.retriesUsed === 0) {
    const earliest = Math.max(now.getTime(), recovery.retryNotBefore.getTime());
    if (next && next.scheduledAt.getTime() <= earliest + recovery.minimumSpacingMs) {
      // Yield only this retry. A scheduler must re-read the next message's outcome;
      // a due time is not delivery evidence, nor proof that its content replaces this SMS.
      return decision("WAIT_FOR_NEXT_MESSAGE", "NEXT_SCHEDULED_MESSAGE_TAKES_PRIORITY", true);
    }
    if (earliest < validUntil.getTime()) {
      const due = now >= recovery.retryNotBefore;
      return {
        ...decision(due ? "RETRY_ELIGIBLE" : "WAIT_FOR_RETRY",
          due ? "SINGLE_RETRY_DUE" : "SINGLE_RETRY_DEFERRED", !due),
        retryPlan: {
          recoveryKey: `GUEST_SMS_RETRY:${message.messageLogId}:1`,
          failedProviderMessageId: sid,
          retryOrdinal: 1,
          notBefore: new Date(recovery.retryNotBefore),
          validUntil: new Date(Math.min(validUntil.getTime(),
            next ? next.scheduledAt.getTime() - recovery.minimumSpacingMs : Infinity)),
        },
      };
    }
    hostReason = "RETRY_WINDOW_UNAVAILABLE";
  }

  const hostAction: SmsFailureHostAction = {
    operationalKey,
    issueCode: "GUEST_SMS_UNKNOWN_DESTINATION",
    title: "Guest SMS was not delivered",
    issue: "The mobile network reported an unknown destination for this guest SMS (Twilio 30005).",
    operationalImpact: type === "GUEST_ACCESS_PASSCODE"
      ? "The guest's access instructions were not delivered by this SMS."
      : "The guest's arrival instructions were not delivered by this SMS.",
    recommendedAction: "Confirm the guest's contact details and deliver the instructions through an available authorized channel. The bounded retry of this message is exhausted or unavailable. Later independently authorized messages are not blocked.",
    nextAutomaticStep: null,
    engine: "COMMUNICATIONS",
    severity: type === "GUEST_ACCESS_PASSCODE" ? "CRITICAL" : "WARNING",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    responsibleActor: "HOST",
    actionRequired: true,
    canAutoResolve: false,
    autoResolveStatus: "NOT_SUPPORTED",
    autoResolveActionCode: null,
    actionTarget: "RESERVATION",
    sourceType: "ENGINE_EVENT",
    organizationId: reservation.organizationId,
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    transitionCode: "GUEST_SMS_DELIVERY_FAILED",
    transitionSummary: "Pin&Go requires review after the same-message retry budget or window is unavailable; later scheduled messages remain independent.",
    transitionedBy: "PIN_GO",
    occurredAt: new Date(now),
    metadata: {
      version: "TWILIO_SMS_FAILURE_V1",
      provider: "twilio",
      messageLogId: message.messageLogId,
      providerMessageId: sid,
      providerDeliveryStatus: status as "UNDELIVERED" | "FAILED",
      providerErrorCode: "30005",
      communicationType: type,
      automatedSameMessageReplay: "BUDGET_EXHAUSTED_OR_UNSAFE",
    },
  };
  return {
    kind: "HOST_ACTION_REQUIRED",
    reason: hostReason,
    deliveryConfirmed: false,
    blockAutomaticReplay: true,
    blockOtherScheduledMessages: false,
    retryPlan: null,
    hostAction,
  };
}
