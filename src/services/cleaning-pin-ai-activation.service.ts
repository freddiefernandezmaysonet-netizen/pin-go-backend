import type { PrismaClient } from "@prisma/client";
import { commercialPinAIEnabled, type ActivationEnvironment } from "../pin-ai/property-activation.js";

/** Staff recovery uses property consent, not the guest conversation window or
 * fee exemption. No legacy reservation pilot grants cleaner hardware authority. */
export async function cleaningPinAIRecoveryAllowed(db: Pick<PrismaClient, "property">,
  scope: { organizationId: string; propertyId: string }, now = new Date(), env: ActivationEnvironment = process.env) {
  if (await commercialPinAIEnabled(db, env, scope) !== true) return false;
  const property = await db.property.findFirst({ where: { id: scope.propertyId, organizationId: scope.organizationId, status: "ACTIVE" },
    select: { pinAITermsAcceptedAt: true, pinAITermsAcceptedBy: true } });
  return !!property?.pinAITermsAcceptedBy && !!property.pinAITermsAcceptedAt && property.pinAITermsAcceptedAt <= now;
}
