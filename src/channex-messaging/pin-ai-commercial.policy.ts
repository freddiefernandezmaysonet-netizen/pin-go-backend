import type { PrismaClient } from "@prisma/client";
import { commercialPinAIEnabled, type ActivationDb, type ActivationScope } from "../pin-ai/property-activation.js";
import { autoConfig } from "./pin-ai-auto.policy.js";
import { guestPinAIAvailability } from "../pin-ai/guest/guest-availability.js";

// The synchronous config is only a platform gate. New automated work must also
// check current property consent; it cannot be authorized by webhook/model IDs.
export async function channelPropertyEnabled(db: ActivationDb, env: NodeJS.ProcessEnv, scope: ActivationScope) {
  const config = autoConfig(env);
  if (!config.allows(scope)) return false;
  if (!config.managed) return true;
  if (await commercialPinAIEnabled(db, env, scope) !== true) return false;
  const property = await db.property.findFirst({ where: { id: scope.propertyId, organizationId: scope.organizationId, status: "ACTIVE" },
    select: { pinAITermsAcceptedAt: true, pinAITermsAcceptedBy: true } });
  return !!property?.pinAITermsAcceptedAt && property.pinAITermsAcceptedAt <= new Date() && !!property.pinAITermsAcceptedBy;
}

export async function channelBookingAvailable(db: Pick<PrismaClient, "reservation">, env: NodeJS.ProcessEnv,
  scope: ActivationScope, bookingId: string | null, now = new Date()) {
  if (!autoConfig(env).managed || !bookingId) return true; // Unlinked inquiries use public facts only.
  const rows = await db.reservation.findMany({ where: { propertyId: scope.propertyId,
    externalProvider: "CHANNEX", externalId: bookingId,
    property: { organizationId: scope.organizationId, status: "ACTIVE" } },
    select: { status: true, checkIn: true, checkOut: true }, take: 2 });
  return rows.length === 1 && !!rows[0] && guestPinAIAvailability(rows[0], now).available;
}

// Preserve the pilot start boundary, and never answer messages from before the
// property's latest activation/reactivation or current consent.
export async function channelActivationSince(db: Pick<PrismaClient, "property" | "apmsAuditEntry">,
  env: NodeJS.ProcessEnv, scope: ActivationScope): Promise<Date | null> {
  if (!await channelPropertyEnabled(db, env, scope)) return null;
  const config = autoConfig(env);
  if (!config.managed) return config.since;
  const property = await db.property.findFirst({ where: { id: scope.propertyId, organizationId: scope.organizationId },
    select: { pinAIRevision: true, pinAITermsAcceptedAt: true } });
  if (!property?.pinAITermsAcceptedAt) return null;
  const event = await db.apmsAuditEntry.findUnique({ where: {
    decisionId: `pin-ai-activation:property:${scope.propertyId}:${property.pinAIRevision}` },
    select: { organizationId: true, propertyId: true, status: true, createdAt: true, metadata: true } });
  const metadata = event?.metadata as { enabled?: boolean } | null;
  if (!event || event.organizationId !== scope.organizationId || event.propertyId !== scope.propertyId ||
      event.status !== "APPLIED" || metadata?.enabled !== true) return null;
  return new Date(Math.max(+config.since, +property.pinAITermsAcceptedAt, +event.createdAt));
}
