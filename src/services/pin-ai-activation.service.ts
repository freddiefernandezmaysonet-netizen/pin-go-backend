import type { Prisma, PrismaClient } from "@prisma/client";
import { propertyActivationEnabled, commercialIncidentRuntimeReady, type ActivationEnvironment } from "../pin-ai/property-activation.js";
import { PIN_AI_BILLING_TERMS } from "../pin-ai/billing-terms.js";
import { type ConnectDebitProvider, pinAIConnectBillingAllows } from "../pin-ai/fee-connect.service.js";

export class PinAIActivationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
type Actor = { id: string; orgId: string; role?: string };
type Tx = Prisma.TransactionClient;
const reject = (status: number, code: string): never => { throw new PinAIActivationError(status, code); };
const orgSelect = { id: true, name: true, pinAIEnabled: true, pinAIRevision: true, stripeConnectAccountId: true } as const;
const propertySelect = { id: true, name: true, pinAIEnabled: true, pinAIRevision: true,
  pinAITermsVersion: true, pinAITermsAcceptedAt: true, pinAITermsAcceptedBy: true,
  organization: { select: orgSelect } } as const;

async function authorize(tx: Tx, actor: Actor, platform = false) {
  const user = await tx.dashboardUser.findFirst({ where: {
    id: actor.id, organizationId: actor.orgId, isActive: true,
    role: { in: platform ? ["PLATFORM_ADMIN"] : ["PLATFORM_ADMIN", "ORG_ADMIN", "ADMIN"] },
  }, select: { id: true } });
  if (!user) reject(403, "PIN_AI_ACTIVATION_FORBIDDEN");
}
function updateBody(body: unknown, property: boolean) {
  if (!body || typeof body !== "object" || Array.isArray(body)) reject(400, "INVALID_REQUEST");
  const value = body as Record<string, unknown>;
  if (property && value.enabled === true && value.acceptedTermsVersion !== undefined && value.acceptedTermsVersion !== PIN_AI_BILLING_TERMS.version) reject(428, "PIN_AI_BILLING_TERMS_REQUIRED");
  const keys = property ? ["enabled", "expectedRevision", "organizationRevision", ...(value.enabled === true && value.acceptedTermsVersion !== undefined ? ["acceptedTermsVersion"] : [])] : ["enabled", "expectedRevision"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)) ||
      typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 ||
      (property && (!Number.isSafeInteger(value.organizationRevision) || Number(value.organizationRevision) < 0))) reject(400, "INVALID_REQUEST");
  return { enabled: value.enabled as boolean, revision: value.expectedRevision as number, orgRevision: value.organizationRevision as number,
    acceptsCurrentTerms: value.acceptedTermsVersion === PIN_AI_BILLING_TERMS.version };
}
function hasCurrentAcceptance(row: Prisma.PropertyGetPayload<{ select: typeof propertySelect }>) {
  return row.pinAITermsVersion === PIN_AI_BILLING_TERMS.version && !!row.pinAITermsAcceptedAt && !!row.pinAITermsAcceptedBy;
}
function propertyView(row: Prisma.PropertyGetPayload<{ select: typeof propertySelect }>, env: ActivationEnvironment) {
  const managed = row.organization.pinAIRevision > 0;
  const runtimeReady = propertyActivationEnabled(env) && env.PIN_AI_GUEST_GATEWAY_ENABLED === "true" &&
    env.PIN_AI_RUNTIME_SHADOW_ENABLED === "true" && env.PIN_AI_RUNTIME_REAL_READ_ENABLED === "true" &&
    commercialIncidentRuntimeReady(env) && pinAIConnectBillingAllows(env, row.organization.id) &&
    env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED === "true" && !!row.organization.stripeConnectAccountId;
  return { propertyId: row.id, name: row.name, enabled: row.pinAIEnabled, revision: row.pinAIRevision,
    billing: { ...PIN_AI_BILLING_TERMS, acceptedAt: row.pinAITermsAcceptedAt, acceptedVersion: row.pinAITermsVersion,
      collectionReady: pinAIConnectBillingAllows(env, row.organization.id) &&
        env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED === "true" && !!row.organization.stripeConnectAccountId },
    organization: { enabled: row.organization.pinAIEnabled, revision: row.organization.pinAIRevision },
    state: !managed ? "EXISTING_SCOPE" : !propertyActivationEnabled(env) ? "PENDING_ACTIVATION" : !row.organization.pinAIEnabled || !row.pinAIEnabled ? "DISABLED" :
      runtimeReady && row.pinAITermsVersion === PIN_AI_BILLING_TERMS.version ? "ENABLED" : "PENDING_ACTIVATION",
    capabilities: { guestAssistance: true, guestIncidents: true, reservationActions: "CONTROLLED_RELEASE", channelReplies: "SEPARATE_ACTIVATION" } };
}
async function audit(tx: Tx, actor: Actor, organizationId: string, propertyId: string | null, enabled: boolean, revision: number) {
  const entityId = propertyId ?? organizationId;
  await tx.apmsAuditEntry.create({ data: { organizationId, propertyId, entityType: propertyId ? "PROPERTY" : "ORGANIZATION",
    entityId, engine: "PIN_AI_ACTIVATION", eventType: "SET_ENABLED", status: "APPLIED",
    decisionId: `pin-ai-activation:${propertyId ? "property" : "organization"}:${entityId}:${revision}`,
    summary: enabled ? "Pin AI enabled" : "Pin AI disabled", metadata: { actorId: actor.id, enabled, revision,
      ...(propertyId && enabled ? { billingTerms: PIN_AI_BILLING_TERMS } : {}) } } });
}
export async function listPinAIOrganizations(db: PrismaClient, actor: Actor, query: unknown) {
  if (typeof query !== "string" || query.length > 80) return reject(400, "INVALID_REQUEST");
  const search = query;
  return db.$transaction(async tx => {
    await authorize(tx, actor, true);
    return { items: await tx.organization.findMany({ where: search ? { OR: [
      { name: { contains: search, mode: "insensitive" } }, { slug: { contains: search, mode: "insensitive" } },
    ] } : {}, select: orgSelect, orderBy: [{ name: "asc" }, { id: "asc" }], take: 30 }) };
  });
}
export async function getPinAIFeeOverview(db: PrismaClient, actor: Actor) {
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const totals = await tx.pinAIReservationFee.groupBy({ by: ["billingStatus"], where: { organizationId: actor.orgId },
      _count: { _all: true }, _sum: { amountCents: true } });
    const recent = await tx.pinAIReservationFee.findMany({ where: { organizationId: actor.orgId },
      orderBy: [{ recordedAt: "desc" }, { reservationId: "desc" }], take: 50,
      select: { reservationId: true, amountCents: true, billingStatus: true, recordedAt: true,
        reservation: { select: { reservationNumber: true } }, property: { select: { name: true } } } });
    const serviceReviews = await tx.pinAIServiceEnrollment.count({ where: { organizationId: actor.orgId,
      status: "NEEDS_REVIEW", reservation: { pinAIReservationFee: null } } });
    return { currency: "USD", serviceReviews, totals: totals.map(r => ({ status: r.billingStatus, count: r._count._all, amountCents: r._sum.amountCents ?? 0 })),
      recent: recent.map(r => ({ reservationId: r.reservationId, reservationNumber: r.reservation.reservationNumber,
        propertyName: r.property.name, amountCents: r.amountCents, status: r.billingStatus, recordedAt: r.recordedAt })) };
  });
}
export async function setPinAIOrganization(db: PrismaClient, actor: Actor, organizationId: string, body: unknown) {
  const input = updateBody(body, false);
  return db.$transaction(async tx => {
    await authorize(tx, actor, true);
    const result = await tx.organization.updateMany({ where: { id: organizationId, pinAIRevision: input.revision },
      data: { pinAIEnabled: input.enabled, pinAIRevision: { increment: 1 } } });
    if (result.count !== 1) reject(409, "PIN_AI_ACTIVATION_CONFLICT");
    await audit(tx, actor, organizationId, null, input.enabled, input.revision + 1);
    return { organizationId, enabled: input.enabled, revision: input.revision + 1 };
  }, { isolationLevel: "Serializable" });
}
export async function getPinAIProperty(db: PrismaClient, env: ActivationEnvironment, actor: Actor, propertyId: string) {
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const row = await tx.property.findFirst({ where: { id: propertyId, organizationId: actor.orgId, status: "ACTIVE" }, select: propertySelect });
    if (!row) return reject(404, "PROPERTY_NOT_FOUND");
    return propertyView(row, env);
  });
}
export async function setPinAIProperty(db: PrismaClient, env: ActivationEnvironment, actor: Actor, propertyId: string, body: unknown,
  provider?: Pick<ConnectDebitProvider, "eligibility">) {
  const input = updateBody(body, true);
  // Check external compatibility outside the SQL transaction, after authority
  // and tenant checks. The account and revisions are rechecked when committing.
  let checkedAccount: string | null = null;
  if (input.enabled) {
    checkedAccount = await db.$transaction(async tx => {
      await authorize(tx, actor);
      const row = await tx.property.findFirst({ where: { id: propertyId, organizationId: actor.orgId, status: "ACTIVE" }, select: propertySelect });
      if (!row) return reject(404, "PROPERTY_NOT_FOUND");
      if (!hasCurrentAcceptance(row) && !input.acceptsCurrentTerms) reject(428, "PIN_AI_BILLING_TERMS_REQUIRED");
      if (row.organization.pinAIRevision !== input.orgRevision || row.pinAIRevision !== input.revision) reject(409, "PIN_AI_ACTIVATION_CONFLICT");
      if (!row.organization.pinAIEnabled) reject(403, "PIN_AI_ORGANIZATION_NOT_ENABLED");
      if (!row.organization.pinAIRevision) reject(409, "PIN_AI_ORGANIZATION_NOT_CONFIGURED");
      if (!row.organization.stripeConnectAccountId) reject(422, "PIN_AI_CONNECT_ACCOUNT_REQUIRED");
      return row.organization.stripeConnectAccountId;
    });
    if (!provider) reject(503, "PIN_AI_CONNECT_VERIFICATION_UNAVAILABLE");
    let compatible = false;
    try { compatible = (await provider!.eligibility(checkedAccount!)).compatible; }
    catch { reject(503, "PIN_AI_CONNECT_VERIFICATION_UNAVAILABLE"); }
    if (!compatible) reject(422, "PIN_AI_CONNECT_ACCOUNT_INCOMPATIBLE");
    // Zero available balance is allowed: accrued fees wait for funds.
  }
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const row = await tx.property.findFirst({ where: { id: propertyId, organizationId: actor.orgId, status: "ACTIVE" }, select: propertySelect });
    if (!row) return reject(404, "PROPERTY_NOT_FOUND");
    if (input.enabled && !hasCurrentAcceptance(row) && !input.acceptsCurrentTerms) reject(428, "PIN_AI_BILLING_TERMS_REQUIRED");
    if (row.organization.pinAIRevision !== input.orgRevision || row.pinAIRevision !== input.revision) reject(409, "PIN_AI_ACTIVATION_CONFLICT");
    if (input.enabled && !row.organization.pinAIEnabled) reject(403, "PIN_AI_ORGANIZATION_NOT_ENABLED");
    if (!row.organization.pinAIRevision) reject(409, "PIN_AI_ORGANIZATION_NOT_CONFIGURED");
    if (input.enabled && row.organization.stripeConnectAccountId !== checkedAccount)
      reject(409, "PIN_AI_ACTIVATION_CONFLICT");
    const acceptance = input.enabled && !hasCurrentAcceptance(row) ? { pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
      pinAITermsAcceptedAt: new Date(), pinAITermsAcceptedBy: actor.id } : {};
    const result = await tx.property.updateMany({ where: { id: propertyId, organizationId: actor.orgId, status: "ACTIVE", pinAIRevision: input.revision },
      data: { pinAIEnabled: input.enabled, pinAIRevision: { increment: 1 }, ...acceptance } });
    if (result.count !== 1) reject(409, "PIN_AI_ACTIVATION_CONFLICT");
    await audit(tx, actor, actor.orgId, propertyId, input.enabled, input.revision + 1);
    return propertyView({ ...row, ...acceptance, pinAIEnabled: input.enabled, pinAIRevision: input.revision + 1 }, env);
  }, { isolationLevel: "Serializable" });
}
