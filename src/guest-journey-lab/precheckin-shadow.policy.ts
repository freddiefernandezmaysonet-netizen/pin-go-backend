import { createHash } from "node:crypto";
import { isGuestOperationalSmsEligible } from "../services/guest-journey-access-communications-bridge.policy";
import { isOtaGuestExternalDeliveryBlocked } from "../services/ota-guest-external-messaging.policy";

export type PrecheckinSnapshot = {
  id: string; propertyId: string; organizationId: string;
  status: string; paymentState: string; cancelledAt: Date | null;
  createdAt: Date; checkIn: Date; checkOut: Date;
  guestEmail: string | null; guestPhone: string | null;
  source: string | null; externalProvider: string | null; externalId: string | null;
  externalRaw: unknown;
};
export type PrecheckinPriorEvidence = {
  dispatches: Array<{ channel: string; status: string }>;
  messages: Array<{ channel: string; status: string | null }>;
};
export type PrecheckinShadowObligation = {
  effectKey: string; event: "PRECHECKIN_DUE"; communicationType: "PRECHECKIN";
  channel: "email" | "sms" | "channex";
  owner: "COMMUNICATIONS" | "CHANNEX_OPERATIONAL";
  state: "REQUIRED" | "NOT_DUE" | "INELIGIBLE" | "EXISTING_EVIDENCE";
  reason: string; gaps: string[];
  mode: "SHADOW"; dispatchAllowed: false;
  expectedIntent: "REQUEST_COMMUNICATION" | "DELEGATE_TO_EXISTING_OWNER";
  claim: "NOT_CREATED"; provider: "resend" | "twilio" | "channex";
  receipt: "NOT_CERTIFIED"; finalEvidence: "OBLIGATION_ONLY";
};

/** Lab-only parity specification. Never creates an executable intent or a send. */
export function planPrecheckinShadow(
  r: PrecheckinSnapshot, now: Date, prior: PrecheckinPriorEvidence,
  env: NodeJS.ProcessEnv,
): PrecheckinShadowObligation[] {
  if (![r.id, r.propertyId, r.organizationId].every(value => value.trim()))
    throw new Error("PRECHECKIN_SHADOW_SCOPE_REQUIRED");
  if (![now, r.createdAt, r.checkIn, r.checkOut].every(value => value instanceof Date && Number.isFinite(value.getTime())) ||
      r.checkIn >= r.checkOut)
    throw new Error("PRECHECKIN_SHADOW_DATES_INVALID");

  const ota = isOtaGuestExternalDeliveryBlocked(r, "sms", env);
  const channels: PrecheckinShadowObligation["channel"][] = ota ? ["channex"] : ["email", "sms"];
  return channels.map(channel => {
    // Legacy PRECHECKIN deduplication is once per reservation/channel. Neither
    // retries, consent changes nor the observation clock may create a new effect.
    // Date-change resend semantics require separate certification.
    const effectKey = "gjshadow_" + createHash("sha256").update(JSON.stringify([
      "precheckin-shadow-v1", r.organizationId, r.propertyId, r.id, "PRECHECKIN", channel,
    ])).digest("hex");
    const result: PrecheckinShadowObligation = {
      effectKey, event: "PRECHECKIN_DUE", communicationType: "PRECHECKIN", channel,
      owner: ota ? "CHANNEX_OPERATIONAL" : "COMMUNICATIONS",
      state: "REQUIRED", reason: "FIRST_SEND_MATERIALIZATION_REQUIRED", gaps: [],
      mode: "SHADOW", dispatchAllowed: false,
      expectedIntent: ota ? "DELEGATE_TO_EXISTING_OWNER" : "REQUEST_COMMUNICATION",
      claim: "NOT_CREATED", provider: ota ? "channex" : channel === "email" ? "resend" : "twilio",
      receipt: "NOT_CERTIFIED", finalEvidence: "OBLIGATION_ONLY",
    };
    const stop = (state: PrecheckinShadowObligation["state"], reason: string) => ({ ...result, state, reason });
    if (r.status !== "ACTIVE" || r.cancelledAt) return stop("INELIGIBLE", "RESERVATION_INACTIVE");
    if (r.paymentState !== "PAID") return stop("INELIGIBLE", "PAYMENT_NOT_READY");
    if (now >= r.checkOut) return stop("INELIGIBLE", "STAY_ENDED");
    if (r.checkIn.getTime() - now.getTime() > 4 * 3600000) return stop("NOT_DUE", "BEFORE_FOUR_HOUR_WINDOW");
    if (ota && now >= r.checkIn) return stop("INELIGIBLE", "OTA_PRECHECKIN_WINDOW_CLOSED");
    if (channel === "email" && now >= r.checkIn && r.createdAt < r.checkIn)
      return stop("INELIGIBLE", "LEGACY_EMAIL_WINDOW_CLOSED");
    if (channel === "email" && !r.guestEmail?.trim()) return stop("INELIGIBLE", "EMAIL_MISSING");
    if (channel === "sms" && !r.guestPhone?.trim()) return stop("INELIGIBLE", "PHONE_MISSING");
    if (channel === "sms" && !isGuestOperationalSmsEligible(r)) return stop("INELIGIBLE", "SMS_NOT_ELIGIBLE");

    // Existing records are a no-replay boundary, never proof of delivery. Even a
    // failed/unknown attempt must be reconciled by its current canonical owner.
    if (prior.dispatches.some(row => row.channel === channel && row.status === "SENT") ||
        prior.messages.some(row => row.channel === channel))
      return stop("EXISTING_EVIDENCE", "RECONCILE_EXISTING_EFFECT_NO_NEW_SEND");
    if (ota) {
      result.gaps.push("CHANNEX_HANDOFF_AND_RECEIPT_NOT_CERTIFIED");
      if (!r.guestEmail && (!r.guestPhone || !isGuestOperationalSmsEligible(r)))
        result.gaps.push("LEGACY_WORKER_HAS_NO_ELIGIBLE_TRIGGER");
    } else {
      result.gaps.push("FIRST_SEND_OUTBOX_AND_INTENT_NOT_IMPLEMENTED");
      if (now >= r.checkIn) result.gaps.push("E7_RETIRES_PRECHECKIN_AFTER_ARRIVAL");
    }
    return result;
  });
}
