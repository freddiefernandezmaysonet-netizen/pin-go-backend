import {
  AccessGrantType,
  AccessMethod,
  AccessStatus,
  HostPayoutStatus,
  NfcAssignmentRole,
  NfcAssignmentStatus,
  PaymentState,
  PrismaClient,
  ReservationStatus,
  StaffAssignmentStatus,
} from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import type {
  AuditDecisionTrace,
  AuditEntry,
  AuditSeverity,
  AuditStatus,
} from "../apms/audit-types";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import { ensureCleanerNfcAccessForConfirmedCleaning } from "./cleaner-access-autopilot.service";
import {
  resolveOperationalIssuesForReservation,
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";
import { mapReservationCleaningOperationalItems } from "../apms/reservation-operational-intelligence.mapper";

const prisma = new PrismaClient();

export type ReservationCompleteFlowStatus =
  | "READY"
  | "READY_WITH_WARNINGS"
  | "NEEDS_ATTENTION"
  | "FAILED";

type ReservationCompleteFlowCheckStatus = "PASS" | "WARNING" | "FAIL";

type ReservationCompleteFlowCheck = {
  rule: string;
  label: string;
  status: ReservationCompleteFlowCheckStatus;
  critical?: boolean;
  required?: boolean;
  recommendedAction?: string;
  metadata?: Record<string, unknown>;
};

type StoredAuditEntry = {
  engine: string;
  decisionId: string;
  status: string;
  severity: string | null;
  reason: string | null;
  summary: string | null;
  recommendedAction: string | null;
  decisions: unknown;
  metadata: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type ReservationCompleteFlowAuditResult = {
  reservationId: string;
  propertyId: string | null;
  organizationId: string | null;
  completeFlowStatus: ReservationCompleteFlowStatus;
  auditEntryId: string | null;
  checks: ReservationCompleteFlowCheck[];
  failedChecks: ReservationCompleteFlowCheck[];
  warningChecks: ReservationCompleteFlowCheck[];
};

const DEFAULT_PROPERTY_TIMEZONE = "America/Puerto_Rico";
const DEFAULT_CHECK_IN_TIME = "15:00";
const DEFAULT_CHECK_OUT_TIME = "11:00";

function normalizeText(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "";
  }
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const decimalLike = value as { toNumber?: () => number };

  if (typeof decimalLike.toNumber === "function") {
    const parsed = decimalLike.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }

  if (value && typeof value === "object") {
    const decimalNumber = toNumber(value);

    if (decimalNumber !== null && typeof (value as any).toNumber === "function") {
      return decimalNumber;
    }

    const output: Record<string, unknown> = {};

    for (const [key, childValue] of Object.entries(value)) {
      if (childValue !== undefined) {
        output[key] = toJsonSafe(childValue);
      }
    }

    return output;
  }

  return value;
}

function normalizeTime(value: unknown, fallback: string) {
  const raw = String(value ?? "").trim();

  if (!/^\d{2}:\d{2}$/.test(raw)) {
    return fallback;
  }

  const [hours, minutes] = raw.split(":").map(Number);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return fallback;
  }

  return raw;
}

function normalizePropertyTimeZone(value?: string | null) {
  const timeZone = String(value ?? "").trim() || DEFAULT_PROPERTY_TIMEZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_PROPERTY_TIMEZONE;
  }
}

function getLocalDateString(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function buildZonedDateFromDateAndTime(
  dateOnly: string,
  time: string,
  timeZone: string
) {
  const [hours, minutes] = time.split(":");

  const localDateTime = new Date(`${dateOnly}T${hours}:${minutes}:00`);

  return fromZonedTime(localDateTime, timeZone);
}

function isSameMinute(left: Date, right: Date) {
  return Math.abs(left.getTime() - right.getTime()) <= 60 * 1000;
}

function isSuccessStatus(value: unknown) {
  const status = normalizeText(value);

  return (
    status === "SUCCESS" ||
    status === "SENT" ||
    status === "DELIVERED" ||
    status === "COMPLETED" ||
    status === "OK"
  );
}

function isFailureStatus(value: unknown) {
  const status = normalizeText(value);

  return status === "FAILED" || status === "ERROR" || status === "BOUNCED";
}

function getAuditSearchText(entry: StoredAuditEntry) {
  return [
    entry.engine,
    entry.status,
    entry.severity,
    entry.reason,
    entry.summary,
    entry.recommendedAction,
    safeStringify(entry.decisions),
    safeStringify(entry.metadata),
  ]
    .join(" ")
    .toUpperCase();
}

function findLatestAuditEntry(
  auditEntries: StoredAuditEntry[],
  predicate: (entry: StoredAuditEntry) => boolean
) {
  return auditEntries
    .filter(predicate)
    .sort((a, b) => {
      const bTime =
        b.completedAt?.getTime() ?? b.startedAt?.getTime() ?? b.createdAt.getTime();
      const aTime =
        a.completedAt?.getTime() ?? a.startedAt?.getTime() ?? a.createdAt.getTime();

      return bTime - aTime;
    })[0];
}

function addCheck(
  checks: ReservationCompleteFlowCheck[],
  input: ReservationCompleteFlowCheck
) {
  checks.push({
    ...input,
    critical: Boolean(input.critical),
    required: input.required ?? true,
    metadata: input.metadata
      ? (toJsonSafe(input.metadata) as Record<string, unknown>)
      : undefined,
  });
}

function getCompleteFlowStatus(
  checks: ReservationCompleteFlowCheck[]
): ReservationCompleteFlowStatus {
  const failedChecks = checks.filter((check) => check.status === "FAIL");
  const criticalFailures = failedChecks.filter((check) => check.critical);
  const warningChecks = checks.filter((check) => check.status === "WARNING");

  if (criticalFailures.length > 0) {
    return "FAILED";
  }

  if (failedChecks.length > 0) {
    return "NEEDS_ATTENTION";
  }

  if (warningChecks.length > 0) {
    return "READY_WITH_WARNINGS";
  }

  return "READY";
}

function getAuditStatus(
  completeFlowStatus: ReservationCompleteFlowStatus
): AuditStatus {
  if (completeFlowStatus === "FAILED") {
    return "FAILED";
  }

  if (completeFlowStatus === "NEEDS_ATTENTION") {
    return "SKIPPED";
  }

  return "SUCCESS";
}

function getAuditSeverity(
  completeFlowStatus: ReservationCompleteFlowStatus
): AuditSeverity {
  if (completeFlowStatus === "FAILED") {
    return "CRITICAL";
  }

  if (
    completeFlowStatus === "NEEDS_ATTENTION" ||
    completeFlowStatus === "READY_WITH_WARNINGS"
  ) {
    return "WARNING";
  }

  return "INFO";
}

function getAuditReason(completeFlowStatus: ReservationCompleteFlowStatus) {
  return `RESERVATION_COMPLETE_FLOW_${completeFlowStatus}`;
}

function getAuditSummary(completeFlowStatus: ReservationCompleteFlowStatus) {
  if (completeFlowStatus === "READY") {
    return "Reservation Complete Flow Audit verified that the reservation is ready.";
  }

  if (completeFlowStatus === "READY_WITH_WARNINGS") {
    return "Reservation Complete Flow Audit verified the reservation with warnings.";
  }

  if (completeFlowStatus === "NEEDS_ATTENTION") {
    return "Reservation Complete Flow Audit found operational items that need attention.";
  }

  return "Reservation Complete Flow Audit found a critical issue that can prevent operational readiness.";
}

function buildRecommendedAction(
  completeFlowStatus: ReservationCompleteFlowStatus,
  checks: ReservationCompleteFlowCheck[]
) {
  if (completeFlowStatus === "READY") {
    return undefined;
  }

  const firstCriticalFailure = checks.find(
    (check) => check.status === "FAIL" && check.critical
  );

  const firstFailure = checks.find((check) => check.status === "FAIL");
  const firstWarning = checks.find((check) => check.status === "WARNING");

  const issue = firstCriticalFailure ?? firstFailure ?? firstWarning;

  if (!issue) {
    return undefined;
  }

  if (issue.recommendedAction) {
    return issue.recommendedAction;
  }

  if (completeFlowStatus === "FAILED") {
    return "Review the critical reservation flow issue before guest arrival.";
  }

  if (completeFlowStatus === "NEEDS_ATTENTION") {
    return "Review the reservation flow checks that need attention before the stay.";
  }

  return "Review the reservation flow warnings when possible.";
}

function getDecisionConfidence(status: ReservationCompleteFlowCheckStatus) {
  if (status === "PASS") return 100;
  if (status === "WARNING") return 75;
  return 0;
}

function toAuditDecisionTrace(
  check: ReservationCompleteFlowCheck
): AuditDecisionTrace {
  return {
    engine: "Reservation",
    rule: check.rule,
    label: check.label,
    adjustment: null,
    adjustmentPercent: null,
    applied: check.status === "PASS",
    confidence: getDecisionConfidence(check.status),
    metadata: {
      checkStatus: check.status,
      critical: Boolean(check.critical),
      required: check.required ?? true,
      recommendedAction: check.recommendedAction ?? null,
      ...(check.metadata ?? {}),
    },
  };
}

function buildAuditEntry(input: {
  reservationId: string;
  decisionId?: string;
  propertyId: string | null;
  organizationId: string | null;
  completeFlowStatus: ReservationCompleteFlowStatus;
  checks: ReservationCompleteFlowCheck[];
  startedAt: Date;
  completedAt: Date;
  recommendedAction?: string;
}): AuditEntry {
  const failedChecks = input.checks.filter((check) => check.status === "FAIL");
  const warningChecks = input.checks.filter(
    (check) => check.status === "WARNING"
  );
  const passedChecks = input.checks.filter((check) => check.status === "PASS");

const primaryIssueCheck =
  failedChecks.find((check) => check.critical) ??
  failedChecks[0] ??
  warningChecks[0] ??
  null;

  const decisions = input.checks.map(toAuditDecisionTrace);

  return {
    engine: "Reservation",
    decisionId:
      input.decisionId ??
      `reservation-complete-flow:${input.reservationId}`,
    entityType: "RESERVATION",
    entityId: input.reservationId,
    eventType:
      input.completeFlowStatus === "FAILED" ? "ACTION_FAILED" : "ACTION_COMPLETED",
    status: getAuditStatus(input.completeFlowStatus),
    severity: getAuditSeverity(input.completeFlowStatus),
    summary: getAuditSummary(input.completeFlowStatus),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(
      0,
      input.completedAt.getTime() - input.startedAt.getTime()
    ),
    reason: getAuditReason(input.completeFlowStatus),
    decisions,
    recommendedAction: input.recommendedAction,
    metadata: toJsonSafe({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      completeFlowStatus: input.completeFlowStatus,

      primaryIssueRule: primaryIssueCheck?.rule ?? null,
      primaryIssueTitle: primaryIssueCheck?.label ?? null,
      primaryIssue:
      primaryIssueCheck?.metadata?.issue ??
      primaryIssueCheck?.recommendedAction ??
      null,
      primaryOperationalImpact:
      primaryIssueCheck?.metadata?.operationalImpact ?? null,
      primaryRecommendedAction:
      primaryIssueCheck?.recommendedAction ?? null,
      primaryIssueEngine:
        String(primaryIssueCheck?.rule ?? "").startsWith("CLEANING_")
          ? "Cleaning"
          : "Reservation",
      canAutoResolve:
        primaryIssueCheck?.metadata?.canAutoResolve ?? false,

      passedChecks: passedChecks.map((check) => check.rule),
      warningChecks: warningChecks.map((check) => check.rule),
      failedChecks: failedChecks.map((check) => check.rule),
      criticalFailureChecks: failedChecks
        .filter((check) => check.critical)
        .map((check) => check.rule),
      totalChecks: input.checks.length,
      passedCount: passedChecks.length,
      warningCount: warningChecks.length,
      failedCount: failedChecks.length,
    }) as Record<string, unknown>,
  };
}

function hasMessageEvidence(input: {
  auditEntries: StoredAuditEntry[];
  dispatchLogs: Array<{
    type: string;
    channel: string;
    status: string;
    createdAt: Date;
  }>;
 messageLogs: Array<{
  channel: string;
  to: string;
  body: string;
  status: string | null;
  error: string | null;
  createdAt: Date;
}>;
  tokens: string[];
  expectedTo?: string | null;
}) {
  const tokens = input.tokens.map(normalizeText).filter(Boolean);

  const matchingAuditEntry = input.auditEntries.some((entry) => {
    if (normalizeText(entry.engine) !== "MESSAGING") return false;

    const searchText = getAuditSearchText(entry);

    return tokens.every((token) => searchText.includes(token)) &&
      isSuccessStatus(entry.status);
  });

  if (matchingAuditEntry) return true;

  const matchingDispatchLog = input.dispatchLogs.some((log) => {
    const searchText = [log.type, log.channel, log.status]
      .join(" ")
      .toUpperCase();

    return tokens.every((token) => searchText.includes(token)) &&
      isSuccessStatus(log.status);
  });

  if (matchingDispatchLog) return true;

  const expectedTo = String(input.expectedTo ?? "").trim().toLowerCase();

  const matchingMessageLog = input.messageLogs.some((log) => {
  const channel = normalizeText(log.channel);
  const statusOk = isSuccessStatus(log.status);
  const recipientMatches =
    !expectedTo || String(log.to ?? "").trim().toLowerCase() === expectedTo;

  const searchText = [
    log.channel,
    log.to,
    log.status,
    log.error,
    (log as any).body,
  ]
    .join(" ")
    .toUpperCase();

  return (
    channel === "EMAIL" &&
    statusOk &&
    recipientMatches &&
    tokens.every((token) => searchText.includes(token))
  );
});

return matchingMessageLog;
}

export async function auditReservationCompleteFlow(
  reservationId: string,
  db: PrismaClient = prisma
): Promise<ReservationCompleteFlowAuditResult> {
  const startedAt = new Date();
  const checks: ReservationCompleteFlowCheck[] = [];

  const reservation = await db.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      propertyId: true,
      reservationNumber: true,
      guestName: true,
      guestEmail: true,
      guestPhone: true,
      checkIn: true,
      checkOut: true,
      paymentState: true,
      totalAmount: true,
      currency: true,
      stripeCheckoutSessionId: true,
      stripePaymentIntentId: true,
      stripeConnectedAccountId: true,
      stripeChargeId: true,
      stripeTransferId: true,
      stripeApplicationFeeId: true,
      basePlatformFeeAmount: true,
      platformFeeAmount: true,
      hostPayoutAmount: true,
      hostPayoutStatus: true,
      hostPayoutFailureReason: true,
      hostPayoutLastSyncedAt: true,
      directBookingProtectionFeeAmount: true,
      identityVerificationRequiredSnapshot: true,
      cancellationPolicyId: true,
      cancellationPolicySnapshot: true,
      guestToken: true,
      guestTokenExpiresAt: true,
      source: true,
      externalProvider: true,
      externalId: true,
      status: true,
      cancelledAt: true,
      cancelledBy: true,
      lastHardwareSyncAt: true,
      lastReconciledAt: true,
      lastReconciledCheckIn: true,
      lastReconciledCheckOut: true,
      createdAt: true,
      updatedAt: true,
      property: {
        select: {
          id: true,
          organizationId: true,
          name: true,
          timezone: true,
          checkInTime: true,
          checkOutTime: true,
          
          cleaningNfcEnabled: true,

          distributionEnabled: true,
          distributionStatus: true,
          distributionLastSyncedAt: true,
          distributionLastError: true,
          organization: {
            select: {
              id: true,
              stripeConnectAccountId: true,
              stripeConnectStatus: true,
              stripeConnectChargesEnabled: true,
              stripeConnectPayoutsEnabled: true,
              stripeConnectDetailsSubmitted: true,
            },
          },
        },
      },
    },
  });

  if (!reservation) {
    addCheck(checks, {
      rule: "RESERVATION_FOUND",
      label: "Reservation Found",
      status: "FAIL",
      critical: true,
      recommendedAction:
        "Review the Stripe webhook and reservation ingest logs. Pin&Go could not find the reservation to audit.",
      metadata: {
        reservationId,
      },
    });

    const completedAt = new Date();
    const completeFlowStatus = getCompleteFlowStatus(checks);
    const recommendedAction = buildRecommendedAction(completeFlowStatus, checks);

    addCheck(checks, {
      rule: "RECOMMENDED_ACTION_CREATED",
      label: "Recommended Action Created",
      status: recommendedAction ? "PASS" : "WARNING",
      critical: false,
      required: false,
      metadata: {
        hasRecommendedAction: Boolean(recommendedAction),
      },
    });

    const finalStatus = getCompleteFlowStatus(checks);

    const auditEntry = buildAuditEntry({
      reservationId,
      propertyId: null,
      organizationId: null,
      completeFlowStatus: finalStatus,
      checks,
      startedAt,
      completedAt,
      recommendedAction,
    });

    const persisted = await persistAuditEntry(db, auditEntry);

    return {
      reservationId,
      propertyId: null,
      organizationId: null,
      completeFlowStatus: finalStatus,
      auditEntryId: persisted?.id ?? null,
      checks,
      failedChecks: checks.filter((check) => check.status === "FAIL"),
      warningChecks: checks.filter((check) => check.status === "WARNING"),
    };
  }

    const property = reservation.property;
  const organization = property.organization;
  const organizationId = property.organizationId;
  const propertyId = property.id;
  const decisionId =
    `reservation-complete-flow:${reservation.id}`;

  if (
    reservation.status ===
    ReservationStatus.CANCELLED
  ) {
    const terminalDecisionId =
      `reservation-complete-flow-cancelled:${reservation.id}`;
    const terminalOccurredAt =
      reservation.cancelledAt ?? reservation.updatedAt;

    addCheck(checks, {
      rule: "RESERVATION_CANCELLED_TERMINAL",
      label: "Reservation Cancelled",
      status: "PASS",
      critical: false,
      required: true,
      metadata: {
        reservationId: reservation.id,
        reservationNumber:
          reservation.reservationNumber ?? null,
        propertyId,
        organizationId,
        reservationStatus:
          reservation.status,
        paymentState:
          reservation.paymentState,
        cancelledAt:
          reservation.cancelledAt ?? null,
        cancelledBy:
          reservation.cancelledBy ?? null,
        terminalWorkflow: true,
        issue:
          "The reservation was cancelled and no longer requires operational readiness checks.",
        operationalImpact:
          "Payment, cleaning and access readiness checks are no longer applicable to this reservation.",
        canAutoResolve: true,
      },
    });

    const completeFlowStatus: ReservationCompleteFlowStatus =
      "READY";

    const auditEntry = buildAuditEntry({
      reservationId: reservation.id,
      decisionId: terminalDecisionId,
      propertyId,
      organizationId,
      completeFlowStatus,
      checks,
      startedAt: terminalOccurredAt,
      completedAt: terminalOccurredAt,
      recommendedAction: undefined,
    });

    const persisted =
      await persistAuditEntry(db, auditEntry);

    try {
      await resolveOperationalIssuesForReservation(
        db,
        {
          reservationId: reservation.id,
          resolutionCode:
            "RESERVATION_CANCELLED",
          resolutionSummary:
            "The reservation was cancelled, so its remaining operational workflows are no longer required.",
          resolutionType: "SUPERSEDED",
          resolvedBy: "SYSTEM",
          sourceType: "AUDIT_ENTRY",
          decisionId: terminalDecisionId,
          sourceAuditEntryId: persisted.id,
          occurredAt: terminalOccurredAt,
        }
      );
    } catch (operationalError: any) {
      console.error(
        "[CANCELLED_RESERVATION_OPERATIONAL_RESOLUTION_ERROR]",
        {
          reservationId: reservation.id,
          reservationNumber:
            reservation.reservationNumber ??
            null,
          decisionId: terminalDecisionId,
          sourceAuditEntryId:
            persisted.id,
          error:
            operationalError?.message ??
            operationalError,
        }
      );
    }

    return {
      reservationId: reservation.id,
      propertyId,
      organizationId,
      completeFlowStatus,
      auditEntryId: persisted.id,
      checks,
      failedChecks: [],
      warningChecks: [],
    };
  }

  const auditSource = normalizeText(
    reservation.source
  );
  const auditExternalProvider = normalizeText(reservation.externalProvider);

  const isManualReservation =
    auditSource === "MANUAL" || auditExternalProvider === "PIN_GO_MANUAL";

  const isDirectBookingReservation =
    auditSource === "DIRECT_BOOKING" ||
    auditExternalProvider === "PIN_GO_DIRECT" ||
    Boolean(reservation.stripeCheckoutSessionId);

  const auditMode = isManualReservation
    ? "MANUAL_RESERVATION"
    : isDirectBookingReservation
    ? "DIRECT_BOOKING"
    : "OTA_RESERVATION";

  const paymentPaidRequired = isDirectBookingReservation;
  const stripeRequired = isDirectBookingReservation;
  const hostPayoutRequired = isDirectBookingReservation;
  const directBookingMessagingEvidenceRequired = isDirectBookingReservation;
  const manualReservationMessagingEvidenceRequired =
  isManualReservation && Boolean(reservation.guestEmail);

const guestConfirmationEmailEvidenceRequired =
  directBookingMessagingEvidenceRequired ||
  manualReservationMessagingEvidenceRequired;
  const cancellationPolicySnapshotRequired = isDirectBookingReservation;


  const [
  overlappingActiveReservationCount,
  accessGrants,
  staffAssignments,
  cleaningConfirmations,
  cleaningNfcAssignments,
  dispatchLogs,
  messageLogs,
  auditEntries,
] = await Promise.all([
    db.reservation.count({
      where: {
        id: { not: reservation.id },
        propertyId: reservation.propertyId,
        status: ReservationStatus.ACTIVE,
        checkIn: { lt: reservation.checkOut },
        checkOut: { gt: reservation.checkIn },
      },
    }),
    db.accessGrant.findMany({
      where: {
        reservationId: reservation.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        lockId: true,
        type: true,
        method: true,
        status: true,
        startsAt: true,
        endsAt: true,
        desiredStartsAt: true,
        desiredEndsAt: true,
        accessCodeMasked: true,
        ttlockKeyboardPwdId: true,
        ttlockKeyId: true,
        ttlockPayload: true,
        lastError: true,
        lastAppliedAt: true,
        revokedReason: true,
        staffMemberId: true,
        lock: {
          select: {
            id: true,
            ttlockLockId: true,
            isActive: true,
            displayName: true,
            ttlockLockName: true,
          },
        },
      },
    }),
    db.staffAssignment.findMany({
      where: {
        reservationId: reservation.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        staffMemberId: true,
        method: true,
        status: true,
        startsAt: true,
        endsAt: true,
        lastError: true,
        retryCount: true,
        accessGrantId: true,
        accessGrant: {
          select: {
            id: true,
            type: true,
            method: true,
            status: true,
            startsAt: true,
            endsAt: true,
            lastError: true,
          },
        },
      },
    }),
    db.cleaningConfirmation.findMany({
      where: {
        reservationId: reservation.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        propertyId: true,
        staffMemberId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

    db.nfcAssignment.findMany({
  where: {
    reservationId: reservation.id,
    role: NfcAssignmentRole.CLEANING,
  },
  orderBy: {
    createdAt: "desc",
  },
  select: {
    id: true,
    nfcCardId: true,
    role: true,
    status: true,
    startsAt: true,
    endsAt: true,
    lastError: true,
    createdAt: true,
    updatedAt: true,
  },
}),

    db.messageDispatchLog.findMany({
      where: {
        reservationId: reservation.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        type: true,
        channel: true,
        status: true,
        createdAt: true,
      },
    }),
   db.messageLog.findMany({
  where: {
    reservationId: reservation.id,
  },
  orderBy: {
    createdAt: "desc",
  },
  take: 50,
  select: {
    channel: true,
    to: true,
    body: true,
    status: true,
    error: true,
    createdAt: true,
  },
}),
    db.apmsAuditEntry.findMany({
      where: {
        reservationId: reservation.id,
        decisionId: {
          not: decisionId,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        engine: true,
        decisionId: true,
        status: true,
        severity: true,
        reason: true,
        summary: true,
        recommendedAction: true,
        decisions: true,
        metadata: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const safeTimeZone = normalizePropertyTimeZone(property.timezone);
  const checkInTime = normalizeTime(property.checkInTime, DEFAULT_CHECK_IN_TIME);
  const checkOutTime = normalizeTime(property.checkOutTime, DEFAULT_CHECK_OUT_TIME);

  const cleaningAccessRequired =
  property.cleaningNfcEnabled === true;

  const expectedCheckIn = buildZonedDateFromDateAndTime(
    getLocalDateString(reservation.checkIn, safeTimeZone),
    checkInTime,
    safeTimeZone
  );

  const expectedCheckOut = buildZonedDateFromDateAndTime(
    getLocalDateString(reservation.checkOut, safeTimeZone),
    checkOutTime,
    safeTimeZone
  );

  const guestAccessGrant = accessGrants.find(
    (grant) =>
      grant.type === AccessGrantType.GUEST &&
      grant.method === AccessMethod.PASSCODE_TIMEBOUND
  );

  const staffAccessGrant = accessGrants.find(
    (grant) => grant.type === AccessGrantType.STAFF
  );

  const latestStaffAssignment = staffAssignments[0] ?? null;
  const latestCleaningConfirmation = cleaningConfirmations[0] ?? null;

  const distributionAudit = findLatestAuditEntry(
    auditEntries,
    (entry) => normalizeText(entry.engine) === "DISTRIBUTION"
  );

  const hasDirectBookingGuestEmailEvidence = hasMessageEvidence({
  auditEntries,
  dispatchLogs,
  messageLogs,
  tokens: ["DIRECT", "BOOKING", "GUEST"],
  expectedTo: reservation.guestEmail,
});

const hasManualReservationGuestEmailEvidence = hasMessageEvidence({
  auditEntries,
  dispatchLogs,
  messageLogs,
  tokens: ["MANUAL", "RESERVATION", "GUEST"],
  expectedTo: reservation.guestEmail,
});

const hasGuestEmailEvidence = isManualReservation
  ? hasManualReservationGuestEmailEvidence
  : hasDirectBookingGuestEmailEvidence;

const hasHostEmailEvidence = hasMessageEvidence({
  auditEntries,
  dispatchLogs,
  messageLogs,
  tokens: ["DIRECT", "BOOKING", "HOST"],
});

 const hasCleanerNotificationEvidence =
  hasMessageEvidence({
    auditEntries,
    dispatchLogs,
    messageLogs,
    tokens: ["CLEANING", "CONFIRMATION"],
  }) ||
  dispatchLogs.some((log) => {
    const type = normalizeText(log.type);
    const channel = normalizeText(log.channel);
    const status = normalizeText(log.status);

    return (
      type === "CLEANING_CONFIRMATION" &&
      channel === "SMS" &&
      isSuccessStatus(status)
    );
  });
  const hasReservationAuditEntry = auditEntries.some(
    (entry) => normalizeText(entry.engine) === "RESERVATION"
  );

  const hasAccessAuditEntry = auditEntries.some(
    (entry) => normalizeText(entry.engine) === "ACCESS"
  );

  const hasCleaningAuditEntry = auditEntries.some(
    (entry) => normalizeText(entry.engine) === "CLEANING"
  );

  addCheck(checks, {
    rule: "RESERVATION_CREATED",
    label: "Reservation Created",
    status: "PASS",
    metadata: {
      reservationId: reservation.id,
      propertyId,
      organizationId,
      status: reservation.status,
      auditMode,
      source: reservation.source,
      externalProvider: reservation.externalProvider,
      externalId: reservation.externalId,
      createdAt: reservation.createdAt,
    },
  });

  const paymentPaid = reservation.paymentState === PaymentState.PAID;
  const paymentStateRecorded = Boolean(reservation.paymentState);

  const reservationTotalAmount = toNumber(reservation.totalAmount);

  const manualPaidReservation =
  isManualReservation && reservation.paymentState === PaymentState.PAID;

  const manualPaymentTotalRecorded =
    !manualPaidReservation ||
    (reservationTotalAmount !== null && reservationTotalAmount > 0);

  const paymentCheckStatus = paymentPaidRequired
    ? paymentPaid
      ? "PASS"
      : "FAIL"
    : manualPaidReservation
    ? manualPaymentTotalRecorded
      ? "PASS"
      : "WARNING"
    : paymentStateRecorded
    ? "PASS"
    : "WARNING";

  const paymentCheckRecommendedAction =
    paymentPaidRequired && !paymentPaid
      ? "Review Stripe payment state before allowing the reservation to proceed."
      : manualPaidReservation && !manualPaymentTotalRecorded
      ? "Manual reservation is marked as paid but totalAmount is missing. Record the total paid amount."
      : undefined;
 addCheck(checks, {
  rule: manualPaidReservation
    ? "MANUAL_PAYMENT_TOTAL_RECORDED"
    : "PAYMENT_PAID",
  label: manualPaidReservation
    ? "Manual Payment Total Recorded"
    : paymentPaidRequired
    ? "Payment Paid"
    : "Payment State Recorded",
  status: paymentCheckStatus,
  critical: paymentPaidRequired && !paymentPaid,
  required: paymentPaidRequired || manualPaidReservation,
  recommendedAction: paymentCheckRecommendedAction,
  metadata: {
    auditMode,
    paymentPaidRequired,
    manualPaidReservation,
    manualPaymentTotalRecorded,
    paymentState: reservation.paymentState,
    totalAmount: reservationTotalAmount,
    currency: reservation.currency,
  },
});
  addCheck(checks, {
    rule: "STRIPE_CHECKOUT_AND_PAYMENT_INTENT_SAVED",
    label: "Stripe Checkout and Payment Intent Saved",
       status: !stripeRequired
      ? "PASS"
      : reservation.stripeCheckoutSessionId && reservation.stripePaymentIntentId
      ? "PASS"
      : "FAIL",
    critical:
      stripeRequired &&
      !(reservation.stripeCheckoutSessionId && reservation.stripePaymentIntentId),
    required: stripeRequired,
    recommendedAction:
      stripeRequired &&
      !(reservation.stripeCheckoutSessionId && reservation.stripePaymentIntentId)
        ? "Review the Stripe webhook persistence. Checkout session or payment intent is missing."
        : undefined,
    metadata: {
      stripeCheckoutSessionId: reservation.stripeCheckoutSessionId,
      stripePaymentIntentId: reservation.stripePaymentIntentId,
      stripeChargeId: reservation.stripeChargeId,
      stripeTransferId: reservation.stripeTransferId,
      stripeApplicationFeeId: reservation.stripeApplicationFeeId,
      auditMode,
      stripeRequired,
   },
  });

  const stripeFinancialRefsComplete = Boolean(
    reservation.stripeChargeId ||
      reservation.stripeTransferId ||
      reservation.stripeApplicationFeeId
  );

  addCheck(checks, {
    rule: "STRIPE_FINANCIAL_REFERENCES_CAPTURED",
    label: "Stripe Financial References Captured",
        status: !stripeRequired
      ? "PASS"
      : stripeFinancialRefsComplete
      ? "PASS"
      : "WARNING",
    critical: false,
    required: stripeRequired,
       recommendedAction:
      stripeRequired && !stripeFinancialRefsComplete
        ? "Stripe payment was stored, but charge, transfer, or application fee references were not fully captured yet."
        : undefined,
    metadata: {
      stripeChargeId: reservation.stripeChargeId,
      stripeTransferId: reservation.stripeTransferId,
      stripeApplicationFeeId: reservation.stripeApplicationFeeId,
      auditMode,
      stripeRequired,
    },
  });

  const organizationPayoutReady = Boolean(
    organization.stripeConnectAccountId &&
      organization.stripeConnectStatus === "READY" &&
      organization.stripeConnectChargesEnabled &&
      organization.stripeConnectPayoutsEnabled
  );

  const payoutStatusReady =
    reservation.hostPayoutStatus === HostPayoutStatus.ROUTED_TO_CONNECT ||
    reservation.hostPayoutStatus === HostPayoutStatus.PAID_TO_HOST ||
    reservation.hostPayoutStatus === HostPayoutStatus.PARTIALLY_REFUNDED;

  const payoutReferenceReady = Boolean(
    reservation.stripeConnectedAccountId && toNumber(reservation.hostPayoutAmount) !== null
  );

  const totalAmount = toNumber(reservation.totalAmount);
  const basePlatformFeeAmount = toNumber(reservation.basePlatformFeeAmount);
  const identityFeeAmount = toNumber(
    reservation.directBookingProtectionFeeAmount
  );
  const platformFeeAmount = toNumber(reservation.platformFeeAmount);
  const hostPayoutAmount = toNumber(reservation.hostPayoutAmount);
  const hasConnectFeeSnapshot =
    reservation.identityVerificationRequiredSnapshot !== null;
  const connectFeeBreakdownValid =
    !hasConnectFeeSnapshot ||
    (totalAmount !== null &&
      basePlatformFeeAmount !== null &&
      identityFeeAmount !== null &&
      platformFeeAmount !== null &&
      hostPayoutAmount !== null &&
      Math.abs(
        basePlatformFeeAmount + identityFeeAmount - platformFeeAmount
      ) < 0.01 &&
      Math.abs(platformFeeAmount + hostPayoutAmount - totalAmount) < 0.01 &&
      (reservation.identityVerificationRequiredSnapshot
        ? identityFeeAmount > 0
        : identityFeeAmount === 0));

  addCheck(checks, {
    rule: "IDENTITY_CHECK_CONNECT_FEE_BREAKDOWN",
    label: "Identity Check Connect Fee Breakdown",
    status: connectFeeBreakdownValid ? "PASS" : "FAIL",
    critical: hasConnectFeeSnapshot && !connectFeeBreakdownValid,
    required: hasConnectFeeSnapshot,
    recommendedAction:
      hasConnectFeeSnapshot && !connectFeeBreakdownValid
        ? "Review the Identity Check fee, total application fee, and host payout snapshots for this reservation."
        : undefined,
    metadata: {
      identityVerificationRequired:
        reservation.identityVerificationRequiredSnapshot,
      basePlatformFeeAmount,
      identityFeeAmount,
      platformFeeAmount,
      hostPayoutAmount,
      totalAmount,
      auditMode,
    },
  });

  addCheck(checks, {
    rule: "HOST_PAYOUT_ROUTE_STATUS",
    label: "Host Payout Route Status",
       status: !hostPayoutRequired
      ? "PASS"
      : organizationPayoutReady && payoutStatusReady && payoutReferenceReady
      ? "PASS"
      : organizationPayoutReady
      ? "FAIL"
      : "WARNING",
    critical:
      hostPayoutRequired &&
      organizationPayoutReady &&
      !(payoutStatusReady && payoutReferenceReady),
    required: hostPayoutRequired,
    recommendedAction:
      hostPayoutRequired &&
      !(organizationPayoutReady && payoutStatusReady && payoutReferenceReady)
        ? "Review Stripe Connect payout routing and host payout status for this reservation."
        : undefined,
    metadata: {
      organizationPayoutReady,
      organizationStripeConnectStatus: organization.stripeConnectStatus,
      organizationChargesEnabled: organization.stripeConnectChargesEnabled,
      organizationPayoutsEnabled: organization.stripeConnectPayoutsEnabled,
      reservationStripeConnectedAccountId: reservation.stripeConnectedAccountId,
      hostPayoutStatus: reservation.hostPayoutStatus,
      hostPayoutAmount,
      platformFeeAmount,
      basePlatformFeeAmount,
      identityFeeAmount,
      hostPayoutFailureReason: reservation.hostPayoutFailureReason,
      hostPayoutLastSyncedAt: reservation.hostPayoutLastSyncedAt,
      auditMode,
      hostPayoutRequired,
    },
  });

  addCheck(checks, {
    rule: "CALENDAR_BLOCKED_BY_ACTIVE_RESERVATION",
    label: "Calendar Blocked by Active Reservation",
    status:
      reservation.status === ReservationStatus.ACTIVE &&
      overlappingActiveReservationCount === 0
        ? "PASS"
        : "FAIL",
    critical:
      reservation.status !== ReservationStatus.ACTIVE ||
      overlappingActiveReservationCount > 0,
    recommendedAction:
      reservation.status === ReservationStatus.ACTIVE &&
      overlappingActiveReservationCount === 0
        ? undefined
        : "Review the calendar immediately. This reservation is not safely blocking availability or has an overlap.",
    metadata: {
      reservationStatus: reservation.status,
      overlappingActiveReservationCount,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
    },
  });

  const distributionActive =
    property.distributionEnabled && property.distributionStatus === "ACTIVE";

  const distributionTimestampFresh = Boolean(
    property.distributionLastSyncedAt &&
      property.distributionLastSyncedAt.getTime() >= reservation.createdAt.getTime() &&
      !property.distributionLastError
  );

  const distributionAuditSucceeded =
    distributionAudit && isSuccessStatus(distributionAudit.status);

  const distributionAuditFailed =
    distributionAudit && isFailureStatus(distributionAudit.status);

  addCheck(checks, {
    rule: "DISTRIBUTION_SYNC_EXECUTED",
    label: "Distribution Sync Executed",
    status: !distributionActive
      ? "PASS"
      : distributionAuditSucceeded || distributionTimestampFresh
      ? "PASS"
      : distributionAuditFailed
      ? "FAIL"
      : "WARNING",
    critical: false,
    required: distributionActive,
    recommendedAction:
      !distributionActive || distributionAuditSucceeded || distributionTimestampFresh
        ? undefined
        : "Review Channex availability sync for this reservation.",
    metadata: {
      distributionEnabled: property.distributionEnabled,
      distributionStatus: property.distributionStatus,
      distributionLastSyncedAt: property.distributionLastSyncedAt,
      distributionLastError: property.distributionLastError,
      distributionAuditDecisionId: distributionAudit?.decisionId ?? null,
      distributionAuditStatus: distributionAudit?.status ?? null,
      distributionAuditReason: distributionAudit?.reason ?? null,
    },
  });

  addCheck(checks, {
    rule: "GUEST_CONFIRMATION_EMAIL_EVIDENCE",
    label: "Guest Confirmation Email Evidence",
        status: !directBookingMessagingEvidenceRequired
      ? "PASS"
      : hasGuestEmailEvidence
      ? "PASS"
      : "WARNING",
    critical: false,
        required: directBookingMessagingEvidenceRequired,
    recommendedAction: hasGuestEmailEvidence
      ? undefined
      : "Guest confirmation email is sent by the Direct Booking flow, but delivery evidence is not persisted yet.",
    metadata: {
      guestEmail: reservation.guestEmail,
      hasGuestEmailEvidence,
      messageDispatchLogCount: dispatchLogs.length,
      messageLogCount: messageLogs.length,
    },
  });

 addCheck(checks, {
  rule: "GUEST_CONFIRMATION_EMAIL_EVIDENCE",
  label: "Guest Confirmation Email Evidence",
  status: !guestConfirmationEmailEvidenceRequired
    ? "PASS"
    : hasGuestEmailEvidence
    ? "PASS"
    : "WARNING",
  critical: false,
  required: guestConfirmationEmailEvidenceRequired,
  recommendedAction:
    guestConfirmationEmailEvidenceRequired && !hasGuestEmailEvidence
      ? "Guest confirmation email delivery evidence is not persisted yet."
      : undefined,
  metadata: {
    auditMode,
    guestEmail: reservation.guestEmail,
    hasGuestEmailEvidence,
    hasDirectBookingGuestEmailEvidence,
    hasManualReservationGuestEmailEvidence,
    directBookingMessagingEvidenceRequired,
    manualReservationMessagingEvidenceRequired,
    guestConfirmationEmailEvidenceRequired,
    messageDispatchLogCount: dispatchLogs.length,
    messageLogCount: messageLogs.length,
  },
});

 addCheck(checks, {
    rule: "GUEST_TOKEN_AND_MANAGE_LINK_READY",
    label: "Guest Token and Manage Reservation Link Ready",
    status: reservation.guestToken ? "PASS" : "FAIL",
    critical: false,
    recommendedAction: reservation.guestToken
      ? undefined
      : "Regenerate the guest token so the Manage Reservation link can work.",
    metadata: {
      hasGuestToken: Boolean(reservation.guestToken),
      guestTokenExpiresAt: reservation.guestTokenExpiresAt,
      guestTokenExpired:
        reservation.guestTokenExpiresAt !== null
          ? reservation.guestTokenExpiresAt.getTime() <= Date.now()
          : null,
    },
  });

  const snapshot = reservation.cancellationPolicySnapshot as any;
  const snapshotExists = Boolean(
    snapshot && typeof snapshot === "object" && Object.keys(snapshot).length > 0
  );

  const cancellationTermsAccepted = Boolean(
    snapshotExists &&
      ((snapshot as any).guestAcceptedCancellationTerms === true ||
        (snapshot as any).cancellationTermsAcceptance?.accepted === true)
  );

  addCheck(checks, {
    rule: "CANCELLATION_POLICY_SNAPSHOT_SAVED",
    label: "Cancellation Policy Snapshot Saved",
       status: !cancellationPolicySnapshotRequired
      ? "PASS"
      : snapshotExists && cancellationTermsAccepted
      ? "PASS"
      : "FAIL",
    critical:
      cancellationPolicySnapshotRequired &&
      !(snapshotExists && cancellationTermsAccepted),
    required: cancellationPolicySnapshotRequired,
    recommendedAction:
      cancellationPolicySnapshotRequired &&
      !(snapshotExists && cancellationTermsAccepted)
        ? "Review cancellation policy snapshot and guest terms acknowledgment for this reservation."
        : undefined,
    metadata: {
      cancellationPolicyId: reservation.cancellationPolicyId,
      snapshotExists,
      cancellationTermsAccepted,
      snapshotPolicyName: snapshot?.name ?? null,
      snapshotPolicyType: snapshot?.type ?? null,
      snapshotRefundBasis: snapshot?.refundBasis ?? null,
      auditMode,
      cancellationPolicySnapshotRequired,
    },
  });

  addCheck(checks, {
    rule: "PROPERTY_TIMEZONE_VALID",
    label: "Property Timezone Valid",
    status:
      safeTimeZone === (property.timezone || DEFAULT_PROPERTY_TIMEZONE)
        ? "PASS"
        : "WARNING",
    critical: false,
    required: false,
    recommendedAction:
      safeTimeZone === (property.timezone || DEFAULT_PROPERTY_TIMEZONE)
        ? undefined
        : "Review the property timezone. Pin&Go is falling back to America/Puerto_Rico.",
    metadata: {
      configuredTimezone: property.timezone,
      resolvedTimezone: safeTimeZone,
    },
  });

  addCheck(checks, {
    rule: "CHECK_IN_TIME_MATCHES_PROPERTY",
    label: "Check-in Time Matches Property",
    status: isSameMinute(reservation.checkIn, expectedCheckIn) ? "PASS" : "FAIL",
    critical: false,
    recommendedAction: isSameMinute(reservation.checkIn, expectedCheckIn)
      ? undefined
      : "Review reservation check-in time. It does not match the property's configured check-in time.",
    metadata: {
      propertyCheckInTime: checkInTime,
      timezone: safeTimeZone,
      reservationCheckIn: reservation.checkIn,
      expectedCheckIn,
    },
  });

  addCheck(checks, {
    rule: "CHECK_OUT_TIME_MATCHES_PROPERTY",
    label: "Check-out Time Matches Property",
    status: isSameMinute(reservation.checkOut, expectedCheckOut) ? "PASS" : "FAIL",
    critical: false,
    recommendedAction: isSameMinute(reservation.checkOut, expectedCheckOut)
      ? undefined
      : "Review reservation check-out time. It does not match the property's configured check-out time.",
    metadata: {
      propertyCheckOutTime: checkOutTime,
      timezone: safeTimeZone,
      reservationCheckOut: reservation.checkOut,
      expectedCheckOut,
    },
  });

  addCheck(checks, {
    rule: "GUEST_ACCESS_GRANT_CREATED",
    label: "Guest Access Grant Created",
    status: guestAccessGrant ? "PASS" : "FAIL",
    critical: !guestAccessGrant,
    recommendedAction: guestAccessGrant
      ? undefined
      : "Create or repair the guest access grant before guest arrival.",
    metadata: {
      accessGrantId: guestAccessGrant?.id ?? null,
      lockId: guestAccessGrant?.lockId ?? null,
      lockActive: guestAccessGrant?.lock?.isActive ?? null,
      lockName:
        guestAccessGrant?.lock?.displayName ??
        guestAccessGrant?.lock?.ttlockLockName ??
        null,
    },
  });

  const guestAccessFailed = Boolean(
    guestAccessGrant &&
      (guestAccessGrant.status === AccessStatus.FAILED ||
        guestAccessGrant.lastError)
  );

  const guestAccessPendingOrActive = Boolean(
    guestAccessGrant &&
      (guestAccessGrant.status === AccessStatus.PENDING ||
        guestAccessGrant.status === AccessStatus.ACTIVE)
  );

  const stayAlreadyEnded = Date.now() > reservation.checkOut.getTime();

  const guestAccessRevokedAfterStay = Boolean(
    guestAccessGrant &&
      guestAccessGrant.status === AccessStatus.REVOKED &&
      stayAlreadyEnded
  );

  addCheck(checks, {
    rule: "TTLOCK_PASSCODE_CREATED_OR_PENDING",
    label: "TTLock Passcode Created or Pending Correctly",
    status:
      guestAccessGrant &&
      !guestAccessFailed &&
      (guestAccessPendingOrActive || guestAccessRevokedAfterStay)
        ? "PASS"
        : "FAIL",
    critical:
      !guestAccessGrant ||
      guestAccessFailed ||
      (!guestAccessPendingOrActive && !guestAccessRevokedAfterStay),
    recommendedAction:
      guestAccessGrant &&
      !guestAccessFailed &&
      (guestAccessPendingOrActive || guestAccessRevokedAfterStay)
        ? undefined
        : "Review TTLock passcode creation for this reservation.",
    metadata: {
      accessGrantId: guestAccessGrant?.id ?? null,
      status: guestAccessGrant?.status ?? null,
      method: guestAccessGrant?.method ?? null,
      accessCodeMasked: guestAccessGrant?.accessCodeMasked ?? null,
      ttlockKeyboardPwdId: guestAccessGrant?.ttlockKeyboardPwdId ?? null,
      ttlockKeyId: guestAccessGrant?.ttlockKeyId ?? null,
      hasTtlockPayload: Boolean(guestAccessGrant?.ttlockPayload),
      lastError: guestAccessGrant?.lastError ?? null,
      lastAppliedAt: guestAccessGrant?.lastAppliedAt ?? null,
    },
  });

  const guestScheduleMatches = Boolean(
    guestAccessGrant &&
      isSameMinute(guestAccessGrant.startsAt, reservation.checkIn) &&
      isSameMinute(guestAccessGrant.endsAt, reservation.checkOut)
  );

  addCheck(checks, {
    rule: "GUEST_ACCESS_SCHEDULE_MATCHES_RESERVATION",
    label: "Guest Access Schedule Matches Reservation",
    status: guestScheduleMatches ? "PASS" : "FAIL",
    critical: !guestScheduleMatches,
    recommendedAction: guestScheduleMatches
      ? undefined
      : "Review guest access schedule. It does not match reservation check-in/check-out.",
    metadata: {
      accessGrantId: guestAccessGrant?.id ?? null,
      reservationCheckIn: reservation.checkIn,
      reservationCheckOut: reservation.checkOut,
      accessStartsAt: guestAccessGrant?.startsAt ?? null,
      accessEndsAt: guestAccessGrant?.endsAt ?? null,
    },
  });

  const staffAssignmentReady = Boolean(
    latestStaffAssignment &&
      (latestStaffAssignment.status === StaffAssignmentStatus.SCHEDULED ||
        latestStaffAssignment.status === StaffAssignmentStatus.ACTIVE ||
        latestStaffAssignment.status === StaffAssignmentStatus.COMPLETED)
  );

  const cleaningConfirmationReady = Boolean(
    latestCleaningConfirmation &&
      ["PENDING", "CONFIRMED"].includes(normalizeText(latestCleaningConfirmation.status))
  );

  addCheck(checks, {
    rule: "CLEANING_TASK_CREATED",
    label: "Cleaning Task Created",
   status:
  !cleaningAccessRequired
    ? "PASS"
    : staffAssignmentReady || cleaningConfirmationReady
    ? "PASS"
    : latestStaffAssignment || latestCleaningConfirmation
    ? "FAIL"
    : "WARNING",
    critical: false,
    required: cleaningAccessRequired,
  recommendedAction:
  cleaningAccessRequired &&
  !(staffAssignmentReady || cleaningConfirmationReady)
    ? "Assign a cleaner and verify cleaning confirmation for this reservation."
    : undefined,
    metadata: {
      cleaningAccessRequired,
      cleaningNfcEnabled: property.cleaningNfcEnabled,
      staffAssignmentId: latestStaffAssignment?.id ?? null,
      staffAssignmentStatus: latestStaffAssignment?.status ?? null,
      staffMemberId:
        latestStaffAssignment?.staffMemberId ??
        latestCleaningConfirmation?.staffMemberId ??
        null,
      cleaningConfirmationId: latestCleaningConfirmation?.id ?? null,
      cleaningConfirmationStatus: latestCleaningConfirmation?.status ?? null,
      staffAssignmentLastError: latestStaffAssignment?.lastError ?? null,
    },
  });

  const cleaningConfirmationStatus = normalizeText(
    latestCleaningConfirmation?.status
  );

  const cleaningConfirmationPending =
    cleaningConfirmationStatus === "PENDING";

  const cleaningConfirmationConfirmed =
    cleaningConfirmationStatus === "CONFIRMED";

  const cleaningConfirmationDeclined =
    cleaningConfirmationStatus === "DECLINED";
const cleaningConfirmationIssue =
  cleaningConfirmationPending
    ? {
        issueCode: "CLEANING_CONFIRMATION_PENDING",
        issueTitle: "Cleaning confirmation pending",
        issue:
          "The assigned cleaner has not confirmed availability for this turnover.",
        operationalImpact:
          "Cleaner access has not been created because confirmation is still pending.",
        recommendedAction:
          "Contact the assigned cleaner. If the cleaner cannot accept the turnover, assign a backup cleaner.",
      }
    : cleaningConfirmationDeclined
    ? {
        issueCode: "CLEANING_CONFIRMATION_DECLINED",
        issueTitle: "Cleaner declined the turnover",
        issue:
          "The assigned cleaner declined the cleaning confirmation for this reservation.",
        operationalImpact:
          "The turnover currently has no confirmed cleaner and may not be completed before the next guest arrives.",
        recommendedAction:
          "Assign a backup cleaner and verify the new cleaner's confirmation.",
      }
    : null;

addCheck(checks, {
 rule: !cleaningAccessRequired
  ? "CLEANING_CONFIRMATION_NOT_REQUIRED"
  : cleaningConfirmationPending
  ? "CLEANING_CONFIRMATION_PENDING"
  : cleaningConfirmationDeclined
  ? "CLEANING_CONFIRMATION_DECLINED"
  : "CLEANING_CONFIRMATION_READY",
 label: !cleaningAccessRequired
  ? "Cleaning Confirmation Not Required"
  : cleaningConfirmationPending
  ? "Cleaning Confirmation Pending"
  : cleaningConfirmationDeclined
  ? "Cleaning Confirmation Declined"
  : "Cleaning Confirmation Ready",
 status:
  !cleaningAccessRequired
    ? "PASS"
    : cleaningConfirmationPending
    ? "WARNING"
    : cleaningConfirmationDeclined
    ? "FAIL"
    : "PASS",
  critical: false,
  required: cleaningAccessRequired,
  recommendedAction:
  cleaningAccessRequired
    ? cleaningConfirmationIssue?.recommendedAction
    : undefined,
  metadata: {
    cleaningAccessRequired,
    cleaningNfcEnabled: property.cleaningNfcEnabled,

    issueCode: cleaningConfirmationIssue?.issueCode ?? null,
    issueTitle: cleaningConfirmationIssue?.issueTitle ?? null,
    issueCode: cleaningConfirmationIssue?.issueCode ?? null,
    issueTitle: cleaningConfirmationIssue?.issueTitle ?? null,
    issue: cleaningConfirmationIssue?.issue ?? null,
    operationalImpact:
      cleaningConfirmationIssue?.operationalImpact ?? null,
    recommendedAction:
      cleaningConfirmationIssue?.recommendedAction ?? null,
    cleaningConfirmationId:
      latestCleaningConfirmation?.id ?? null,
    cleaningConfirmationStatus:
      latestCleaningConfirmation?.status ?? null,
    staffMemberId:
      latestCleaningConfirmation?.staffMemberId ??
      latestStaffAssignment?.staffMemberId ??
      null,
    canAutoResolve: !cleaningAccessRequired,
  },
});

  const latestCleaningNfcAssignment =
    cleaningNfcAssignments.find(
      (assignment) =>
        normalizeText(assignment.role) === "CLEANING"
    );

  const cleaningNfcStatus = normalizeText(
    latestCleaningNfcAssignment?.status
  );

  const cleanerNfcScheduled =
    cleaningNfcStatus ===
    NfcAssignmentStatus.SCHEDULED;

  const cleanerNfcProvisioning =
    cleaningNfcStatus ===
    NfcAssignmentStatus.PROVISIONING;

  const cleanerNfcAccessReady =
    cleaningNfcStatus ===
    NfcAssignmentStatus.ACTIVE;

  const cleanerNfcFailed =
    cleaningNfcStatus ===
    NfcAssignmentStatus.FAILED;

  let cleanerNfcLifecycleValid = Boolean(
    cleanerNfcScheduled ||
      cleanerNfcProvisioning ||
      cleanerNfcAccessReady
  );

  const legacyCleanerAccessReady = Boolean(
    latestStaffAssignment?.accessGrantId ||
      latestStaffAssignment?.accessGrant ||
      staffAccessGrant
  );

  let cleanerAccessReady = Boolean(
    cleanerNfcLifecycleValid ||
      legacyCleanerAccessReady
  );

  let cleanerAccessAutopilotResult: Awaited<
    ReturnType<
      typeof ensureCleanerNfcAccessForConfirmedCleaning
    >
  > | null = null;

 if (
  cleaningAccessRequired &&
  cleaningConfirmationConfirmed &&
  !cleanerNfcLifecycleValid
) {
    cleanerAccessAutopilotResult =
      await ensureCleanerNfcAccessForConfirmedCleaning({
        prisma: db,
        reservationId: reservation.id,
        confirmationId:
          latestCleaningConfirmation?.id ?? null,
        trigger: "RESERVATION_COMPLETE_FLOW_AUDIT",
      });

    if (cleanerAccessAutopilotResult.ok) {
      cleanerNfcLifecycleValid = true;
      cleanerAccessReady = true;
    }
  }

  const cleanerAccessWaitingForConfirmation = Boolean(
    latestCleaningConfirmation &&
      cleaningConfirmationPending &&
      !cleanerAccessReady
  );

  const cleanerAccessRequiredNow = Boolean(
    !cleaningConfirmationPending &&
      (cleaningConfirmationConfirmed ||
        staffAssignmentReady)
  );

 const cleanerAccessCheckStatus:
  ReservationCompleteFlowCheckStatus =
  !cleaningAccessRequired
    ? "PASS"
    : cleanerNfcFailed
    ? "FAIL"
    : cleanerNfcProvisioning
    ? "WARNING"
    : cleanerAccessReady ||
      cleanerAccessWaitingForConfirmation
    ? "PASS"
    : cleaningConfirmationDeclined ||
      cleanerAccessRequiredNow
    ? "FAIL"
    : "WARNING";
  const cleanerAccessRecommendedAction =
  !cleaningAccessRequired
    ? undefined
    : cleanerNfcAccessReady
      ? undefined
      : cleanerNfcScheduled
      ? undefined
      : cleanerNfcProvisioning
      ? "Cleaner NFC access is currently being provisioned. Verify that it becomes ACTIVE before the cleaning window begins."
      : cleanerNfcFailed
      ? "Cleaner NFC provisioning failed. Review the assignment error, TTLock gateway, cleaner card mapping, and retry status."
      : cleanerAccessWaitingForConfirmation
      ? undefined
      : cleaningConfirmationDeclined
      ? "Cleaner declined the cleaning confirmation. Assign a backup cleaner and verify access."
      : cleanerAccessAutopilotResult?.escalated
      ? "Cleaner confirmed availability, but Access Autopilot could not schedule NFC access. Review the cleaner card mapping or active lock."
      : cleanerAccessRequiredNow
      ? "Cleaner has confirmed or is scheduled, but cleaner NFC access was not found. Create or repair cleaner access."
      : "Verify cleaner confirmation and cleaner access workflow for this reservation.";

 addCheck(checks, {
    rule: "CLEANER_ACCESS_CREATED",
    label: "Cleaner Access Lifecycle Valid",
    status: cleanerAccessCheckStatus,
    critical: false,
    required: cleaningAccessRequired,
    recommendedAction: cleanerAccessRecommendedAction,
    metadata: {
      cleaningAccessRequired,
      cleaningNfcEnabled: property.cleaningNfcEnabled,
      
      cleanerAccessReady,
      cleanerAccessRequiredNow,
      cleanerAccessWaitingForConfirmation,
      cleaningConfirmationStatus: latestCleaningConfirmation?.status ?? null,
      cleaningConfirmationId: latestCleaningConfirmation?.id ?? null,
      staffAssignmentReady,
      staffAssignmentId: latestStaffAssignment?.id ?? null,
      staffAssignmentAccessGrantId: latestStaffAssignment?.accessGrantId ?? null,
      linkedAccessGrantId: latestStaffAssignment?.accessGrant?.id ?? null,
      staffAccessGrantId: staffAccessGrant?.id ?? null,
      staffAccessGrantStatus:
        latestStaffAssignment?.accessGrant?.status ?? staffAccessGrant?.status ?? null,
      staffAccessGrantLastError:
        latestStaffAssignment?.accessGrant?.lastError ??
        staffAccessGrant?.lastError ??
        null,
      cleanerNfcAccessReady,
      cleanerNfcLifecycleValid,
      cleanerNfcScheduled,
      cleanerNfcProvisioning,
      cleanerNfcFailed,
      legacyCleanerAccessReady,
      cleaningNfcAssignmentId: latestCleaningNfcAssignment?.id ?? null,
      cleaningNfcCardId: latestCleaningNfcAssignment?.nfcCardId ?? null,
      cleaningNfcStatus: latestCleaningNfcAssignment?.status ?? null,
      cleaningNfcStartsAt: latestCleaningNfcAssignment?.startsAt ?? null,
      cleaningNfcEndsAt: latestCleaningNfcAssignment?.endsAt ?? null,
      cleaningNfcLastError: latestCleaningNfcAssignment?.lastError ?? null,
      cleanerAccessAutopilotAttempted: Boolean(cleanerAccessAutopilotResult),
      cleanerAccessAutopilotOk: cleanerAccessAutopilotResult?.ok ?? null,
      cleanerAccessAutopilotReason: cleanerAccessAutopilotResult?.reason ?? null,
      cleanerAccessAutopilotError: cleanerAccessAutopilotResult?.error ?? null,
      cleanerAccessAutopilotEscalated:
      cleanerAccessAutopilotResult?.escalated ?? null,
    },
  });

  addCheck(checks, {
    rule: "CLEANER_NOTIFICATION_EVIDENCE",
    label: "Cleaner Notification Evidence",
    status:
      !cleaningAccessRequired ||
      hasCleanerNotificationEvidence
        ? "PASS"
        : "WARNING",
    critical: false,
    required: cleaningAccessRequired,
   recommendedAction:
     cleaningAccessRequired &&
        !hasCleanerNotificationEvidence
        ? "Cleaner notification evidence is not persisted yet. Verify cleaner communication if this stay is near check-in."
        : undefined,
    metadata: {
      cleaningAccessRequired,
      cleaningNfcEnabled: property.cleaningNfcEnabled,
      hasCleanerNotificationEvidence,
      messageDispatchLogCount: dispatchLogs.length,
      messageLogCount: messageLogs.length,
    },
  });

  const guestRevokeCoveredByTimeboundGrant = Boolean(
    guestAccessGrant &&
      guestAccessGrant.method === AccessMethod.PASSCODE_TIMEBOUND &&
      guestAccessGrant.endsAt
  );

  const expiredGuestAccessStillActive = Boolean(
    guestAccessGrant &&
      stayAlreadyEnded &&
      (guestAccessGrant.status === AccessStatus.ACTIVE ||
        guestAccessGrant.status === AccessStatus.PENDING)
  );

  addCheck(checks, {
    rule: "REVOKE_WORKFLOW_COVERED",
    label: "Revoke Workflow Covered",
    status: expiredGuestAccessStillActive
      ? "FAIL"
      : guestRevokeCoveredByTimeboundGrant
      ? "PASS"
      : "WARNING",
    critical: expiredGuestAccessStillActive,
    recommendedAction: expiredGuestAccessStillActive
      ? "Revoke expired guest access immediately."
      : guestRevokeCoveredByTimeboundGrant
      ? undefined
      : "Verify revoke coverage for this reservation's access grants.",
    metadata: {
      stayAlreadyEnded,
      guestAccessGrantId: guestAccessGrant?.id ?? null,
      guestAccessStatus: guestAccessGrant?.status ?? null,
      guestAccessEndsAt: guestAccessGrant?.endsAt ?? null,
      lastReconciledAt: reservation.lastReconciledAt,
      lastHardwareSyncAt: reservation.lastHardwareSyncAt,
      revokedReason: guestAccessGrant?.revokedReason ?? null,
    },
  });

  addCheck(checks, {
    rule: "APMS_AUDIT_LOG_GENERATED",
    label: "APMS Audit Log Generated",
    status:
      hasReservationAuditEntry || hasAccessAuditEntry || hasCleaningAuditEntry
        ? "PASS"
        : "WARNING",
    critical: false,
    required: false,
    recommendedAction:
      hasReservationAuditEntry || hasAccessAuditEntry || hasCleaningAuditEntry
        ? undefined
        : "APMS audit evidence was not found before the complete flow audit.",
    metadata: {
      auditEntryCount: auditEntries.length,
      hasReservationAuditEntry,
      hasAccessAuditEntry,
      hasCleaningAuditEntry,
      hasDistributionAuditEntry: Boolean(distributionAudit),
    },
  });

  const provisionalStatus = getCompleteFlowStatus(checks);
  const recommendedAction = buildRecommendedAction(provisionalStatus, checks);

  addCheck(checks, {
    rule: "RECOMMENDED_ACTION_CREATED",
    label: "Recommended Action Created",
    status:
      provisionalStatus === "READY" || recommendedAction ? "PASS" : "WARNING",
    critical: false,
    required: false,
    metadata: {
      completeFlowStatus: provisionalStatus,
      hasRecommendedAction: Boolean(recommendedAction),
      recommendedAction: recommendedAction ?? null,
    },
  });

  const completeFlowStatus = getCompleteFlowStatus(checks);
  const completedAt = new Date();

   const auditEntry = buildAuditEntry({
    reservationId: reservation.id,
    propertyId,
    organizationId,
    completeFlowStatus,
    checks,
    startedAt,
    completedAt,
    recommendedAction,
  });

  const persisted = await persistAuditEntry(db, auditEntry);

  try {
    const operationalItems =
      mapReservationCleaningOperationalItems({
        organizationId,
        propertyId,
        reservationId: reservation.id,
        reservationNumber:
          reservation.reservationNumber ?? null,
        guestName: reservation.guestName ?? null,

        cleaningConfirmationId:
          latestCleaningConfirmation?.id ?? null,
        cleaningConfirmationStatus:
          latestCleaningConfirmation?.status ?? null,
        staffMemberId:
          latestCleaningConfirmation?.staffMemberId ??
          latestStaffAssignment?.staffMemberId ??
          null,
        cleanerName: null,

        cleanerAccessReady,
        cleanerAccessAutopilotAttempted:
          Boolean(cleanerAccessAutopilotResult),
        cleanerAccessAutopilotOk:
          cleanerAccessAutopilotResult?.ok ?? null,
        cleanerAccessAutopilotReason:
          cleanerAccessAutopilotResult?.reason ?? null,
        cleanerAccessAutopilotError:
          cleanerAccessAutopilotResult?.error ?? null,
        cleanerAccessAutopilotEscalated:
          cleanerAccessAutopilotResult?.escalated ?? null,

        decisionId,
        sourceAuditEntryId: persisted.id,
        signalAt: completedAt,
      });

    for (const operationalItem of operationalItems) {
      await upsertOperationalIssue(
        db,
        operationalItem
      );
    }
  } catch (operationalIntelligenceError: any) {
    console.error(
      "[RESERVATION_OPERATIONAL_INTELLIGENCE_ERROR]",
      {
        reservationId: reservation.id,
        reservationNumber:
          reservation.reservationNumber ?? null,
        decisionId,
        sourceAuditEntryId: persisted.id,
        error:
          operationalIntelligenceError?.message ??
          operationalIntelligenceError,
      }
    );
  }

  return {
    reservationId: reservation.id,
    propertyId,
    organizationId,
    completeFlowStatus,
    auditEntryId: persisted?.id ?? null,
    checks,
    failedChecks: checks.filter((check) => check.status === "FAIL"),
    warningChecks: checks.filter((check) => check.status === "WARNING"),
  };
}

export async function auditReservationCompleteFlowSafe(
  reservationId: string,
  db: PrismaClient = prisma
) {
  try {
    return await auditReservationCompleteFlow(reservationId, db);
  } catch (error: any) {
    console.error("[RESERVATION_COMPLETE_FLOW_AUDIT_ERROR]", {
      reservationId,
      error: error?.message ?? error,
    });

    return null;
  }
}
