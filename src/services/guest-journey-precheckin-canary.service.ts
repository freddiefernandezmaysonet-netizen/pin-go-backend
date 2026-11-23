import type { PrismaClient } from "@prisma/client";
import { materializeScopedPrecheckin } from "./guest-journey-precheckin-materialization.service";
import { runGuestJourneyCommunicationsOwnerCycle } from "./guest-journey-communications-owner-cycle.service";
import { reconcileGuestJourneyCommunicationEvidence } from "./guest-journey-communications-recovery.service";
import type { GuestJourneyCommunicationsOwnerConfig } from "./guest-journey-communications-owner.config";

export async function runPrecheckinCanary(db: PrismaClient, config: GuestJourneyCommunicationsOwnerConfig, now: Date) {
  if (process.env.GUEST_JOURNEY_CANARY_EXECUTE !== "1") return;
  const {GUEST_JOURNEY_CANARY_ORGANIZATION_ID: organizationId, GUEST_JOURNEY_CANARY_PROPERTY_ID: propertyId,
    GUEST_JOURNEY_CANARY_RESERVATION_ID: reservationId, GUEST_JOURNEY_CANARY_EMAIL: email,
    GUEST_JOURNEY_CANARY_SMS: sms} = process.env;
  if (!organizationId || !propertyId || !reservationId || !email || !sms ||
      process.env.MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED !== "1") throw Error("PRECHECKIN_CANARY_CONFIGURATION_INVALID");
  const scope = {organizationId, propertyId};
  await materializeScopedPrecheckin(db, scope, reservationId, now, undefined, {email, sms});
  await runGuestJourneyCommunicationsOwnerCycle(db, {...config, enabled: true, organizationIds: [organizationId],
    propertyIds: [propertyId], batchSize: 2}, {now, canaryReservationId: reservationId});
  const pending = await db.guestJourneyCoordinationIntent.findMany({where: {
    reservationId, targetEngine: "COMMUNICATIONS", reasonCode: "PRECHECKIN_CANARY_FIRST_SEND", status: "WAITING_FOR_EVIDENCE",
    reservation: {propertyId, property: {organizationId}},
  }, take: 2, select: {id: true}});
  for (const intent of pending) await reconcileGuestJourneyCommunicationEvidence(db, {...scope, intentId: intent.id});
}
