import type { PrismaClient } from "@prisma/client";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service.js";
import type { SmsRecoveryScope } from "./twilio-sms-recovery.store.js";

const fail = (reason: string): never => { throw new Error(`SMS_ACCESS_GAP_${reason}`); };
const validId = (value: string) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const validDate = (value: Date) => value instanceof Date && Number.isFinite(value.getTime());

export function twilioSmsAccessGapKey(scope: SmsRecoveryScope): string {
  if (![scope.messageLogId, scope.organizationId, scope.propertyId, scope.reservationId].every(validId) ||
      !/^SM[0-9a-fA-F]{32}$/.test(scope.originalProviderMessageId)) fail("INVALID_SCOPE");
  // Separate from the retry-owning issue: host attention must not consume its slot.
  return `GUEST_ACCESS_SMS_GAP:${scope.messageLogId}:${scope.originalProviderMessageId}`;
}

type Source = {
  provider: string | null; channel: string; communicationType: string | null;
  providerMessageId: string | null; providerDeliveryStatus: string | null;
  providerErrorCode: string | null; providerStatusUpdatedAt: Date | null;
  accessGrantId: string | null; createdAt: Date;
  sameRecipient: boolean; emailMissing: boolean;
  status: string; cancelledAt: Date | null; checkIn: Date; checkOut: Date; propertyStatus: string;
};
export type SmsAccessGapResult = {
  kind: "CREATED" | "PRESERVED" | "NO_ACTION";
  reason: string;
  issueId: string | null;
  blockOtherScheduledMessages: false;
};

/** Internal projection of persisted evidence; NOT an HTTP receiver or sender.
 * No callback/user payload may be passed as delivery truth. It reads the exact
 * persisted SID and current tenant/reservation/access evidence under DB locks.
 * Missing email + failed access SMS can require host attention while one delayed
 * retry remains available. No lease or MessageLog is changed by this projector.
 */
export async function persistTwilioSmsAccessGap(
  db: Pick<PrismaClient, "$transaction">,
  scope: SmsRecoveryScope,
  clock: () => Date = () => new Date()
): Promise<SmsAccessGapResult> {
  const key = twilioSmsAccessGapKey(scope);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sms-recovery:${scope.messageLogId}`}, 0))`;
    const [source] = await tx.$queryRaw<Source[]>`
      SELECT m."provider", m."channel", m."communicationType", m."providerMessageId",
        m."providerDeliveryStatus", m."providerErrorCode", m."providerStatusUpdatedAt",
        m."accessGrantId", m."createdAt", r."status", r."cancelledAt", r."checkIn", r."checkOut",
        p."status" AS "propertyStatus",
        (COALESCE(length(btrim(r."guestPhone")),0)>0 AND btrim(m."to")=btrim(r."guestPhone")) AS "sameRecipient",
        (COALESCE(length(btrim(r."guestEmail")),0)=0) AS "emailMissing"
      FROM "MessageLog" m JOIN "Reservation" r ON r."id"=m."reservationId"
      JOIN "Property" p ON p."id"=r."propertyId"
      WHERE m."id"=${scope.messageLogId} AND m."organizationId"=${scope.organizationId}
        AND m."propertyId"=${scope.propertyId} AND m."reservationId"=${scope.reservationId}
        AND p."id"=${scope.propertyId} AND p."organizationId"=${scope.organizationId}
      FOR UPDATE OF m,r,p`;
    if (!source) return fail("SOURCE_SCOPE_MISMATCH");
    if (source.provider !== "twilio" || source.channel !== "sms" ||
        source.providerMessageId !== scope.originalProviderMessageId) fail("SOURCE_ATTEMPT_CHANGED");
    const matches = await tx.messageLog.count({ where: {
      provider: "twilio", providerMessageId: scope.originalProviderMessageId,
    } });
    if (matches !== 1) fail("AMBIGUOUS_PROVIDER_SID");
    const noAction = (reason: string): SmsAccessGapResult => ({
      kind: "NO_ACTION", reason, issueId: null, blockOtherScheduledMessages: false,
    });
    if (source.communicationType !== "GUEST_ACCESS_PASSCODE") return noAction("TYPE_OUT_OF_SCOPE");
    if (!["UNDELIVERED", "FAILED"].includes(source.providerDeliveryStatus ?? "") ||
        source.providerErrorCode !== "30005") return noAction("NO_PERSISTED_30005");
    if (!source.emailMissing) return noAction("EMAIL_PRESENT_REQUIRES_SEPARATE_DELIVERY_EVIDENCE");
    if (!source.sameRecipient) return noAction("RECIPIENT_CHANGED");
    const [grant] = source.accessGrantId ? await tx.$queryRaw<Array<{
      status: string; startsAt: Date; endsAt: Date;
    }>>`SELECT g."status",g."startsAt",g."endsAt" FROM "AccessGrant" g
        JOIN "Lock" l ON l."id"=g."lockId"
        WHERE g."id"=${source.accessGrantId} AND g."reservationId"=${scope.reservationId}
          AND l."propertyId"=${scope.propertyId} AND l."isActive"=true
        FOR UPDATE OF g,l` : [];
    if (!grant || grant.status !== "ACTIVE") return noAction("CURRENT_ACCESS_EVIDENCE_MISSING");
    const now = clock();
    if (!validDate(now)) return fail("INVALID_CLOCK");
    const failureAt = source.providerStatusUpdatedAt;
    if (!failureAt || !validDate(failureAt) || failureAt > now || source.createdAt > now) {
      return fail("FAILURE_TIME_INVALID");
    }
    if (source.status !== "ACTIVE" || source.cancelledAt !== null || source.propertyStatus !== "ACTIVE" ||
        now >= source.checkOut || now >= grant.endsAt || grant.startsAt >= grant.endsAt) {
      return noAction("RESERVATION_OR_ACCESS_NOT_CURRENT");
    }
    const recovered = await tx.twilioSmsRecovery.findUnique({
      where: { messageLogId: scope.messageLogId },
      select: { state: true, organizationId: true, propertyId: true, reservationId: true, originalProviderMessageId: true },
    });
    if (recovered && (recovered.organizationId !== scope.organizationId ||
        recovered.propertyId !== scope.propertyId || recovered.reservationId !== scope.reservationId ||
        recovered.originalProviderMessageId !== scope.originalProviderMessageId)) fail("JOURNAL_SCOPE_MISMATCH");
    if (recovered?.state === "DELIVERED") return noAction("RECOVERY_DELIVERY_RECORDED");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const existing = await tx.operationalIssue.findUnique({ where: { operationalKey: key } });
    if (existing) {
      if (existing.organizationId !== scope.organizationId || existing.propertyId !== scope.propertyId ||
          existing.reservationId !== scope.reservationId) fail("ISSUE_SCOPE_MISMATCH");
      return { kind: "PRESERVED", reason: "EXISTING_ISSUE_OWNS_RESOLUTION", issueId: existing.id,
        blockOtherScheduledMessages: false };
    }
    const issue = await upsertOperationalIssue(tx, {
      operationalKey: key,
      issueCode: "GUEST_ACCESS_SMS_FAILED_EMAIL_MISSING",
      title: "Guest access instructions need attention",
      issue: "The access SMS was not delivered (Twilio 30005), and this reservation has no guest email destination.",
      operationalImpact: "Delivery of access instructions is not confirmed. This does not indicate a failed lock or invalidate the guest's access.",
      recommendedAction: "Contact the guest through the reservation's authorized channel, share current instructions and confirm receipt. A separately eligible delayed SMS retry may continue.",
      nextAutomaticStep: null,
      engine: "COMMUNICATIONS", severity: "CRITICAL", workflowState: "ACTION_REQUIRED",
      visibility: "HOST", responsibleActor: "HOST", actionRequired: true,
      canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED", autoResolveActionCode: null,
      organizationId: scope.organizationId, propertyId: scope.propertyId, reservationId: scope.reservationId,
      actionTarget: "RESERVATION", sourceType: "ENGINE_EVENT",
      firstDetectedAt: failureAt, lastSignalAt: now,
      transitionCode: "GUEST_ACCESS_COMMUNICATION_GAP_DETECTED",
      transitionSummary: "Access SMS failed and guest email is missing; host attention coexists with bounded retry without changing access.",
      transitionedBy: "PIN_GO", occurredAt: now,
      metadata: {
        version: "TWILIO_SMS_ACCESS_GAP_V1", provider: "twilio",
        messageLogId: scope.messageLogId, providerMessageId: scope.originalProviderMessageId,
        providerDeliveryStatus: source.providerDeliveryStatus, providerErrorCode: "30005",
        emailDestinationMissing: true, retryBudgetUnchanged: true,
      },
    });
    return { kind: "CREATED", reason: "ACCESS_SMS_FAILED_EMAIL_MISSING", issueId: issue.id,
      blockOtherScheduledMessages: false };
  }, { maxWait: 10_000, timeout: 20_000 });
}
