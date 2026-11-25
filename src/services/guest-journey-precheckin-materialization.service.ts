import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { firstPrecheckinBlockReason } from "./guest-journey-communications-precheckin.policy";
import { buildGoogleMapsLink, buildGuestVerificationUrl, buildPreCheckinMessage, shouldIncludePreCheckinVerification } from "./preCheckinSms.service";
import { formatPropertyArrivalLocation } from "./property-arrival-location";
import { getGuestIntlLocale, resolveGuestLanguage } from "./guest-language.service";
import { getGuestPreCheckinEmailSubject } from "../lib/mailer";
import { buildGuestJourneyCoordinationIntentKey, normalizeGuestJourneyCoordinationPayload } from "./guest-journey-coordination-intent-key";
import { persistAuditEntry } from "../apms/audit-persistence.service";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function materializeScopedPrecheckin(
  db: PrismaClient, scope: {organizationId: string; propertyId: string}, reservationId: string, now: Date,
  dependencies = {persistAudit: persistAuditEntry},
  canary?: {email: string; sms: string},
) {
  return db.$transaction(async tx => {
    const lock = `GUEST_JOURNEY_COORDINATION:${reservationId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    const r = await tx.reservation.findFirstOrThrow({ where: {
      id: reservationId, propertyId: scope.propertyId, property: { organizationId: scope.organizationId },
    }, include: { property: true, guestJourney: true, messageDispatchLogs: { where: { type: "PRECHECKIN" } } } });
    if (!r.guestJourney) throw Error("FIRST_SEND_JOURNEY_MISSING");
    const previous = await tx.messageLog.findMany({ where: { ...scope, reservationId, communicationType: "PRECHECKIN" },
      select: { id: true, channel: true, status: true } });
    const decisions: Array<{ channel: string; action: string; messageLogId?: string }> = [];
    for (const channel of ["email", "sms"] as const) {
      if (canary && canary[channel] !== (channel === "email" ? r.guestEmail : r.guestPhone)?.trim()) continue;
      const blocked = firstPrecheckinBlockReason(r, channel, now, Boolean(canary));
      if (blocked) { decisions.push({ channel, action: blocked }); continue; }
      const prior = previous.filter(message => message.channel === channel);
      if (prior.length || r.messageDispatchLogs.some(row => row.channel === channel)) {
        decisions.push({ channel, action: "PRESERVE_EXISTING_EFFECT" }); continue;
      }
      // Once per reservation/channel, independent of retry counts, observed time,
      // consent revisions and recipient edits. Changed effects need reconciliation.
      const id = `gjfirst_${digest([scope, reservationId, "PRECHECKIN", channel])}`;
      const language = resolveGuestLanguage(r.preferredLanguage);
      const { address, mapsLink } = buildGoogleMapsLink(r.property);
      const verificationUrl = shouldIncludePreCheckinVerification(r) && r.guestToken
        ? buildGuestVerificationUrl(r.guestToken) : null;
      const arrivalLocation = formatPropertyArrivalLocation(r.property, language);
      const retryPayload = {
        reservationNumber: r.reservationNumber ?? "Pending", guestName: r.guestName,
        propertyName: r.property.name, checkIn: r.checkIn.toISOString(), checkOut: r.checkOut.toISOString(),
        propertyTimeZone: r.property.timezone, arrivalLocation, address, mapsLink, verificationUrl, preferredLanguage: language,
      };
      const body = channel === "email" ? JSON.stringify({ kind: "PIN_GO_EMAIL_DELIVERY", type: "PRECHECKIN",
        subject: getGuestPreCheckinEmailSubject(retryPayload), retryPayload }) : buildPreCheckinMessage({
        guestName: r.guestName, propertyName: r.property.name,
        checkInTime: new Intl.DateTimeFormat(getGuestIntlLocale(language), {
          timeZone: r.property.timezone ?? "UTC", hour: "2-digit", minute: "2-digit", hour12: true,
        }).format(r.checkIn), arrivalLocation, address, mapsLink, verifyLink: verificationUrl,
        language, arrivalStarted: now >= r.checkIn,
      });
      await tx.messageLog.create({ data: { id, ...scope, reservationId, channel,
        to: channel === "email" ? r.guestEmail!.trim() : r.guestPhone!.trim(), body,
        provider: channel === "email" ? "resend" : "twilio", communicationType: "PRECHECKIN", status: "APMS_PENDING" } });
      if (canary) await tx.messageDispatchLog.create({ data: {
        reservationId, type: "PRECHECKIN", channel, status: "E7_OWNED",
      } });
      const identity = {
        reservationId, intentType: "REQUEST_COMMUNICATION" as const, targetEngine: "COMMUNICATIONS" as const,
        reasonCode: canary ? "PRECHECKIN_CANARY_FIRST_SEND" : "PRECHECKIN_FIRST_SEND_REQUIRED", expectedOutcomeCode: "COMMUNICATION_DELIVERY_FINAL",
        evidenceFingerprint: digest({ id, body, checkIn: r.checkIn, checkOut: r.checkOut }),
        payload: { messageLogId: id, communicationType: "PRECHECKIN", channel },
      };
      const intent = await tx.guestJourneyCoordinationIntent.create({ data: {
        ...identity, intentKey: buildGuestJourneyCoordinationIntentKey(identity), journeyId: r.guestJourney.id,
        payload: normalizeGuestJourneyCoordinationPayload(identity.intentType, identity.payload)!, nextActionAt: now,
      } });
      await dependencies.persistAudit(tx, {
        engine: "COMMUNICATIONS", entityType: "RESERVATION", entityId: reservationId,
        decisionId: `${id}:materialized`, eventType: "DECISION_APPLIED", status: "SUCCESS", severity: "INFO",
        reason: "PRECHECKIN_FIRST_SEND_MATERIALIZED", summary: "Pending pre-check-in outbox and canonical intent committed together; delivery not certified.",
        startedAt: now, completedAt: now, durationMs: 0,
        metadata: { ...scope, reservationId, messageLogId: id, intentId: intent.id, channel,
          providerCalls: 0, deliveryCertified: false, contentFingerprint: digest(body) },
      });
      decisions.push({ channel, action: "CREATED", messageLogId: id });
    }
    return decisions;
  });
}
