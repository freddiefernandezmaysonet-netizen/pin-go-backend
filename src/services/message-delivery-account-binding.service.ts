import type { PrismaClient } from "@prisma/client";

export function deliveryAccountBindingEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED;
  if (value && value !== "0" && value !== "1") throw Error("DELIVERY_ACCOUNT_BINDING_CONFIG_INVALID");
  return value === "1";
}

// Read transport-provided provenance, never today's configuration for an old
// message. Resend's namespace is captured alongside its client at construction.
export function readDeliveryAccountKey(provider: string, result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const key = (result as { deliveryAccountKey?: unknown }).deliveryAccountKey;
  if (typeof key !== "string") return null;
  if (provider === "twilio") return /^AC[a-f0-9]{32}$/i.test(key) ? key : null;
  if (provider === "resend") return /^[a-zA-Z0-9_-]{1,100}$/.test(key) ? key : null;
  return null;
}

// Read-only readiness check. Does not apply receipts, send, or backfill legacy
// messages. All three provider identifiers must agree before tenant validation.
export async function resolveCapturedReceiptMessage(
  db: Pick<PrismaClient, "messageLog" | "property">,
  receipt: { provider: string; accountKey: string; providerMessageId: string },
) {
  if (!receipt.providerMessageId.trim() || !readDeliveryAccountKey(receipt.provider, {deliveryAccountKey: receipt.accountKey})) {
    return { state: "INVALID_CORRELATION" as const };
  }
  const matches = await db.messageLog.findMany({ where: {
    provider: receipt.provider, providerAccountKey: receipt.accountKey, providerMessageId: receipt.providerMessageId,
  }, take: 2, select: { id: true, organizationId: true, propertyId: true, reservationId: true } });
  if (!matches.length) return { state: "UNBOUND_OR_UNKNOWN" as const };
  if (matches.length !== 1) return { state: "AMBIGUOUS" as const };
  const message = matches[0];
  if (!message) return { state: "UNBOUND_OR_UNKNOWN" as const };
  if (!message.organizationId || !message.propertyId || !await db.property.findFirst({
    where: { id: message.propertyId, organizationId: message.organizationId }, select: { id: true },
  })) return { state: "SCOPE_MISMATCH" as const };
  return { state: "MATCHED" as const, messageLogId: message.id,
    organizationId: message.organizationId, propertyId: message.propertyId, reservationId: message.reservationId };
}
