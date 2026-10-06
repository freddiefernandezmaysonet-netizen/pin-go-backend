import type { PrismaClient } from "@prisma/client";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";
import { pinAIConnectBillingAllows } from "./fee-connect.service.js";

export type ActivationEnvironment = Readonly<Record<string, string | undefined>>;
export type ActivationDb = Pick<PrismaClient, "property">;
export type ActivationScope = { organizationId: string; propertyId: string };

export function propertyActivationEnabled(env: ActivationEnvironment) {
  return env.PIN_AI_PROPERTY_ACTIVATION_ENABLED === "true";
}

// null means the organization is still on the existing pilot. A configured
// organization never falls back to a reservation allowlist after being disabled.
export async function commercialPinAIEnabled(db: ActivationDb, env: ActivationEnvironment, scope: ActivationScope): Promise<boolean | null> {
  if (!propertyActivationEnabled(env)) return null;
  const row = await db.property.findFirst({
    where: { id: scope.propertyId, organizationId: scope.organizationId, status: "ACTIVE" },
    select: { pinAIEnabled: true, pinAITermsVersion: true, organization: { select: { pinAIEnabled: true, pinAIRevision: true, stripeConnectAccountId: true } } },
  });
  if (!row) return false;
  if (row.organization.pinAIRevision === 0) return null;
  return row.organization.pinAIEnabled && row.pinAIEnabled && row.pinAITermsVersion === PIN_AI_BILLING_TERMS.version &&
    !!row.organization.stripeConnectAccountId && pinAIConnectBillingAllows(env, scope.organizationId) &&
    env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED === "true";
}

// Existing cases remain readable/actionable by their authorized host after new
// conversations are disabled. This does not permit new guest reports or sends.
export async function commercialIncidentPropertyIds(db: ActivationDb, env: ActivationEnvironment, organizationId?: string) {
  if (!propertyActivationEnabled(env)) return [] as string[];
  const rows = await db.property.findMany({ where: {
    ...(organizationId ? { organizationId } : {}), pinAIRevision: { gt: 0 },
    organization: { pinAIRevision: { gt: 0 } },
  }, select: { id: true } });
  return rows.map(row => row.id);
}

export function commercialIncidentRuntimeReady(env: ActivationEnvironment) {
  return env.PIN_AI_INCIDENT_ENABLED === "true" && env.PIN_AI_HOST_INCIDENT_ENABLED === "true";
}

export async function commercialIncidentHistoryAllowed(db: ActivationDb, env: ActivationEnvironment, scope: ActivationScope) {
  if (!propertyActivationEnabled(env)) return false;
  return !!await db.property.findFirst({ where: { id: scope.propertyId, organizationId: scope.organizationId,
    pinAIRevision: { gt: 0 }, organization: { pinAIRevision: { gt: 0 } } }, select: { id: true } });
}
