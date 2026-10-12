import { pinAIConnectBillingAllows } from "../pin-ai/fee-connect.service.js";
import { pinAIHybridBillingAllows } from "../pin-ai/billing-terms.js";
import type { PrismaClient } from "@prisma/client";
import { commercialPinAIEnabled, type ActivationEnvironment } from "../pin-ai/property-activation.js";

/** Staff recovery uses property consent, not the guest conversation window or
 * fee exemption. No legacy reservation pilot grants cleaner hardware authority. */
export async function cleaningPinAIRecoveryAllowed(db: Pick<PrismaClient, "property">,
  scope: { organizationId: string; propertyId: string }, now = new Date(), env: ActivationEnvironment = process.env) {
  // Guest fee exemptions do not broaden staff hardware authority.
  if (env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED !== "true" ||
    !(env.PIN_AI_HYBRID_BILLING_ENABLED === "true" ? pinAIHybridBillingAllows(env, scope.organizationId) :
      pinAIConnectBillingAllows(env, scope.organizationId))) return false;
  if (await commercialPinAIEnabled(db, env, scope) !== true) return false;
  const property = await db.property.findFirst({ where: { id: scope.propertyId, organizationId: scope.organizationId, status: "ACTIVE" },
    select: { pinAITermsAcceptedAt: true, pinAITermsAcceptedBy: true, organization: { select: { stripeConnectAccountId: true } } } });
  return !!property?.organization.stripeConnectAccountId && !!property.pinAITermsAcceptedBy && !!property.pinAITermsAcceptedAt && property.pinAITermsAcceptedAt <= now;
}
