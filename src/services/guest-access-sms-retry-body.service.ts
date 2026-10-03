import type { PrismaClient } from "@prisma/client";
import { decryptAccessCode } from "./access-code-crypto.service.js";
import { buildGuestPasscodeSmsBody } from "./messaging.service.js";
import { resolveGuestLanguage } from "./guest-language.service.js";
import { formatPropertyArrivalLocation } from "./property-arrival-location.js";

/** Access retries use current credential/location evidence, never a masked log body. */
export async function buildGuestAccessSmsRetryBody(prisma: PrismaClient, message: {
  communicationType: string | null; body: string; reservationId: string | null;
  accessGrantId: string | null; organizationId: string | null; propertyId: string | null; to: string;
}, options: { now?: Date; decrypt?: typeof decryptAccessCode } = {}): Promise<string> {
  if (message.communicationType !== "GUEST_ACCESS_PASSCODE") return message.body;
  if (!message.reservationId || !message.accessGrantId) throw new Error("ACCESS_SMS_RETRY_SCOPE_MISSING");
  const grant = await prisma.accessGrant.findFirst({ where: {
    id: message.accessGrantId, reservationId: message.reservationId,
    ...(message.propertyId || message.organizationId ? { reservation: {
      ...(message.propertyId ? { propertyId: message.propertyId } : {}),
      ...(message.organizationId ? { property: { organizationId: message.organizationId } } : {}),
    } } : {}),
  }, include: { secureAccessCode: true, reservation: { include: { property: true } } } });
  const r = grant?.reservation;
  if (!grant || !r || grant.type !== "GUEST" || grant.method !== "PASSCODE_TIMEBOUND" || grant.status !== "ACTIVE" ||
    !grant.lastAppliedAt || !grant.secureAccessCode?.accessCodeEnc || r.status !== "ACTIVE" || r.cancelledAt ||
    r.guestAccessReleaseStatus !== "RELEASED" || !r.guestAccessReleasedAt ||
    grant.endsAt <= (options.now ?? new Date()) || grant.startsAt.getTime() !== r.checkIn.getTime() || grant.endsAt.getTime() !== r.checkOut.getTime() ||
    !r.guestPhone || r.guestPhone.trim() !== message.to.trim()) throw new Error("ACCESS_SMS_RETRY_EVIDENCE_INVALID");
  return buildGuestPasscodeSmsBody({ code: (options.decrypt ?? decryptAccessCode)(grant.secureAccessCode.accessCodeEnc),
    validUntil: grant.endsAt, language: resolveGuestLanguage(r.preferredLanguage),
    arrivalLocation: formatPropertyArrivalLocation(r.property, r.preferredLanguage),
    ...(r.property.timezone ? { timezone: r.property.timezone } : {}),
  });
}
