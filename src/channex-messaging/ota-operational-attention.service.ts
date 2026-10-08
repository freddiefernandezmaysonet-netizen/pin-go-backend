import type { PrismaClient } from "@prisma/client";
import {
  upsertOperationalIssue,
  reopenOperationalIssue,
} from "../apms/operational-intelligence.service.js";

export type OtaOperationalType = "PRECHECKIN" | "GUEST_ACCESS_PASSCODE" | "CHECKOUT";
export type OtaOperationalDeliveryEvidence = {
  organizationId: string;
  propertyId: string;
  reservationId: string;
  reservationNumber: string | null;
  type: OtaOperationalType;
  ok: boolean;
  error?: string | null;
  now: Date;
};

const ACTIONABLE_ERRORS = new Set([
  "OTA_OPERATIONAL_THREAD_MISSING_OR_AMBIGUOUS",
  "OTA_OPERATIONAL_THREAD_NOT_ELIGIBLE",
  "OTA_OPERATIONAL_THREAD_SEARCH_LIMIT",
  "OTA_OPERATIONAL_MAPPING_MISSING",
  "OTA_OPERATIONAL_TRANSPORT_DISABLED",
  "OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN",
  "OTA_OPERATIONAL_PREFLIGHT_FAILED",
  "OTA_OPERATIONAL_BOOKING_ID_INVALID",
  "OTA_OPERATIONAL_MESSAGE_INVALID",
  "OTA_OPERATIONAL_RESERVATION_CHANGED",
  "OTA_OPERATIONAL_UNEXPECTED",
  // Existing Airbnb canary delivers through its own receipt boundary.
  // Its transport/mapping/thread errors must reach the same host workflow.
  "AIRBNB_BOOKING_THREAD_MISSING_OR_AMBIGUOUS",
  "AIRBNB_THREAD_NOT_ELIGIBLE",
  "AIRBNB_THREAD_SEARCH_LIMIT",
  "AIRBNB_PROPERTY_MAPPING_MISSING",
  "AIRBNB_BOOKING_MAPPING_MISSING",
  "AIRBNB_TRANSPORT_DISABLED",
  "AIRBNB_SEND_OUTCOME_UNKNOWN",
  "AIRBNB_PREFLIGHT_FAILED",
  "AIRBNB_PROPERTY_TIMEZONE_MISSING",
  "AIRBNB_RESERVATION_CHANGED",
  "AIRBNB_MESSAGE_TOO_LONG",
]);

export function otaOperationalIssueKey(input: Pick<OtaOperationalDeliveryEvidence, "reservationId" | "type">): string {
  return `OTA_CHANNEX_GUEST_MESSAGE:${input.reservationId}:${input.type}`;
}

/**
 * Mission Control visibility for guest-facing Channex delivery gaps.
 * Never adds a guest/host SMS/email or replays an uncertain send.
 */
export async function reconcileOtaOperationalDeliveryAttention(
  prisma: PrismaClient,
  input: OtaOperationalDeliveryEvidence,
  dependencies: {
    upsert: typeof upsertOperationalIssue;
    reopen: typeof reopenOperationalIssue;
  } = { upsert: upsertOperationalIssue, reopen: reopenOperationalIssue },
): Promise<"CREATED" | "UPDATED" | "REOPENED" | "RESOLVED" | "UNCHANGED"> {
  const reason = String(input.error ?? "").trim().toUpperCase();
  if (!input.ok && !ACTIONABLE_ERRORS.has(reason)) return "UNCHANGED";
  const operationalKey = otaOperationalIssueKey(input);
  const existing = await prisma.operationalIssue.findUnique({
    where: { operationalKey },
    select: { workflowState: true, metadata: true, firstDetectedAt: true },
  });

  if (input.ok) {
    if (!existing || existing.workflowState === "RESOLVED") return "UNCHANGED";
    await dependencies.upsert(prisma, {
      operationalKey,
      issueCode: "OTA_CHANNEX_GUEST_MESSAGE_DELIVERY_GAP",
      title: "OTA message accepted by Channex",
      issue: "The operational guest message has a provider-accepted delivery receipt.",
      operationalImpact: null,
      recommendedAction: null,
      nextAutomaticStep: null,
      engine: "COMMUNICATIONS",
      severity: "INFO", workflowState: "RESOLVED", visibility: "HOST",
      responsibleActor: "PIN_GO", actionRequired: false,
      canAutoResolve: true, autoResolveStatus: "SUCCEEDED",
      organizationId: input.organizationId, propertyId: input.propertyId,
      reservationId: input.reservationId, reservationNumber: input.reservationNumber,
      sourceType: "WORKER", actionTarget: "MESSAGING",
      firstDetectedAt: existing.firstDetectedAt, lastSignalAt: input.now,
      resolvedAt: input.now, resolutionCode: "OTA_CHANNEX_PROVIDER_ACCEPTED",
      resolutionSummary: "Channex accepted the operational guest message.",
      resolutionType: "AUTOMATIC", resolvedBy: "PIN_GO",
      metadata: { type: input.type, status: "CHANNEX_ACCEPTED", sanitized: true },
      transitionCode: "OTA_CHANNEX_GUEST_MESSAGE_ACCEPTED",
      transitionSummary: "The guest OTA message is accepted by Channex.",
      transitionedBy: "PIN_GO", occurredAt: input.now,
    });
    return "RESOLVED";
  }

  const metadata = existing?.metadata;
  const currentError = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) && "errorCode" in metadata
      ? String(metadata.errorCode ?? "") : null;
  if (existing?.workflowState === "ACTION_REQUIRED" && currentError === reason) return "UNCHANGED";
  const critical = input.type === "GUEST_ACCESS_PASSCODE";
  const recommendedAction = ["OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN", "AIRBNB_SEND_OUTCOME_UNKNOWN"].includes(reason)
    ? "Review the Channex conversation and provider receipt before any manual resend; delivery outcome is uncertain."
    : "Review the OTA conversation in Channex, confirm the Messages app and booking mapping, and provide the instructions through the OTA if needed. Do not use an automatic SMS/email fallback.";

  if (existing?.workflowState === "RESOLVED") {
    await dependencies.reopen(prisma, {
      operationalKey, workflowState: "ACTION_REQUIRED",
      severity: critical ? "CRITICAL" : "WARNING",
      responsibleActor: "HOST", actionRequired: true,
      recommendedAction, nextAutomaticStep: null,
      canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED",
      reopenCode: "OTA_CHANNEX_GUEST_MESSAGE_NEW_DELIVERY_GAP",
      reopenSummary: "A new operational OTA messaging delivery gap needs attention.",
      reopenedBy: "PIN_GO", sourceType: "WORKER",
      occurredAt: input.now,
      metadata: { type: input.type, errorCode: reason, sanitized: true },
    });
  }

  await dependencies.upsert(prisma, {
    operationalKey,
    issueCode: "OTA_CHANNEX_GUEST_MESSAGE_DELIVERY_GAP",
    title: critical ? "Guest access message requires attention" : "OTA guest message requires attention",
    issue: "Pin&Go could not confirm Channex acceptance for a scheduled operational guest message.",
    operationalImpact: critical
      ? "The guest may not have received the current access instructions."
      : "The guest may not have received an operational stay message.",
    recommendedAction, nextAutomaticStep: null,
    engine: "COMMUNICATIONS",
    severity: critical ? "CRITICAL" : "WARNING",
    workflowState: "ACTION_REQUIRED", visibility: "HOST",
    responsibleActor: "HOST", actionRequired: true,
    canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED",
    organizationId: input.organizationId, propertyId: input.propertyId,
    reservationId: input.reservationId, reservationNumber: input.reservationNumber,
    sourceType: "WORKER", actionTarget: "MESSAGING",
    firstDetectedAt: existing?.firstDetectedAt ?? input.now, lastSignalAt: input.now,
    metadata: { type: input.type, errorCode: reason, sanitized: true },
    transitionCode: "OTA_CHANNEX_GUEST_MESSAGE_DELIVERY_GAP",
    transitionSummary: "Channex operational guest delivery requires host attention.",
    transitionedBy: "PIN_GO", occurredAt: input.now,
  });
  return existing ? existing.workflowState === "RESOLVED" ? "REOPENED" : "UPDATED" : "CREATED";
}
