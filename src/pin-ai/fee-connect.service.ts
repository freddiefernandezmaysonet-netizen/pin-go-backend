import { createHash, randomUUID } from "node:crypto";
import type { PinAIReservationFee, PrismaClient } from "@prisma/client";
import type { ActivationEnvironment } from "./property-activation.js";
import { PIN_AI_BILLING_TERMS } from "./billing-terms.js";

export type ConnectDebitPayment = { id: string; accountId: string; amount: number; currency: string;
  paid: boolean; status: string; metadata: Record<string, string> };
export type ConnectDebitProvider = {
  eligibility(accountId: string): Promise<{ compatible: boolean; availableCents: number }>;
  create(fee: PinAIReservationFee, key: string): Promise<ConnectDebitPayment>;
  retrieve(id: string): Promise<ConnectDebitPayment>;
  reconcile?(fee: PinAIReservationFee, now: Date): Promise<{ payments: ConnectDebitPayment[]; complete: boolean }>;
};
export class ConnectDebitInsufficientBalanceError extends Error {}
export function pinAIConnectBillingAllows(env: ActivationEnvironment, organizationId: string) {
  const ids = (env.PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return env.PIN_AI_CONNECT_DEBIT_ENABLED === "true" && !ids.includes("*") && ids.includes(organizationId);
}
export const pinAIConnectDebitKey = (id: string, generation = 0) =>
  `pin-ai-connect-fee-v1:${createHash("sha256").update(id).digest("hex")}:${generation}`;
const REPLAY_WINDOW = 23 * 60 * 60_000;
const LEASE_MS = 90_000;

// No guest/card/subscription fallback. The pinned account is never replaced by
// a newly connected account. Reconcile uncertain creates using the same key.
export async function collectPinAIConnectFee(db: PrismaClient, provider: ConnectDebitProvider,
  env: ActivationEnvironment, reservationId: string, now = new Date()) {
  const fee = await db.pinAIReservationFee.findUnique({ where: { reservationId } });
  if (!fee || !pinAIConnectBillingAllows(env, fee.organizationId)) return "DISABLED";
  const recoverExpired = fee.billingStatus === "NEEDS_REVIEW" && fee.lastError === "CONNECT_REPLAY_WINDOW_EXPIRED";
  if (fee.billingStatus === "PAID" || (fee.billingStatus === "NEEDS_REVIEW" && !recoverExpired)) return fee.billingStatus;
  if (fee.serviceStartedAt > now) return "NOT_DUE";
  if (fee.exportNextAttemptAt && fee.exportNextAttemptAt > now) return "NOT_DUE";
  if (fee.exportLeaseUntil && fee.exportLeaseUntil > now) return "BUSY";
  const token = randomUUID();
  const claimed = await db.pinAIReservationFee.updateMany({ where: { reservationId,
    billingStatus: fee.billingStatus, exportAttempts: fee.exportAttempts,
    OR: [{ exportLeaseUntil: null }, { exportLeaseUntil: { lte: now } }] },
    data: { exportLeaseToken: token, exportLeaseUntil: new Date(now.getTime() + LEASE_MS),
      exportAttempts: { increment: 1 } } });
  if (claimed.count !== 1) return "BUSY";
  const current = await db.pinAIReservationFee.findUniqueOrThrow({ where: { reservationId } });
  const finish = async (status: string, data: Parameters<typeof db.pinAIReservationFee.updateMany>[0]["data"]) => {
    const saved = await db.pinAIReservationFee.updateMany({ where: { reservationId, exportLeaseToken: token },
      data: { ...data, exportLeaseToken: null, exportLeaseUntil: null } });
    return saved.count === 1 ? status : "LEASE_LOST";
  };
  const review = (code: string) => finish("NEEDS_REVIEW", { billingStatus: "NEEDS_REVIEW", lastError: code });
  try {
    if (current.termsVersion !== PIN_AI_BILLING_TERMS.version || current.amountCents !== 100 ||
      current.currency !== "USD" || !current.stripeConnectedAccountId ||
      current.acceptedAt > current.serviceStartedAt || !current.acceptedBy ||
      current.stripeInvoiceItemId || current.stripeInvoiceId ||
      (recoverExpired && !current.debitStartedAt) || (current.debitStartedAt && current.debitStartedAt > now) ||
      (!["PENDING_CONNECT", "PENDING_BALANCE"].includes(current.billingStatus) && !recoverExpired)) return await review("CONNECT_FEE_SCOPE_INVALID");
    let payment: ConnectDebitPayment;
    if (current.stripeDebitPaymentId) payment = await provider.retrieve(current.stripeDebitPaymentId);
    else {
      if (current.debitStartedAt && now.getTime() - current.debitStartedAt.getTime() >= REPLAY_WINDOW) {
        // After key retention may expire, only GET evidence is allowed. Even a
        // complete empty search never authorizes another create.
        if (!provider.reconcile) return await review("CONNECT_REPLAY_WINDOW_EXPIRED");
        const evidence = await provider.reconcile(current, now);
        if (!evidence.complete) return await review("CONNECT_RECONCILIATION_INCOMPLETE");
        if (evidence.payments.length !== 1) return await review(evidence.payments.length
          ? "CONNECT_MULTIPLE_DEBITS_FOUND" : "CONNECT_DEBIT_NOT_FOUND");
        const candidate = evidence.payments[0];
        if (!candidate) return await review("CONNECT_DEBIT_NOT_FOUND");
        payment = candidate;
      } else {
      if (!current.debitStartedAt) {
        const organization = await db.organization.findUnique({ where: { id: current.organizationId },
          select: { stripeConnectAccountId: true } });
        if (organization?.stripeConnectAccountId !== current.stripeConnectedAccountId)
          return await review("CONNECT_ACCOUNT_CHANGED");
        const eligibility = await provider.eligibility(current.stripeConnectedAccountId);
        if (!eligibility.compatible) return await review("CONNECT_ACCOUNT_INCOMPATIBLE");
        if (eligibility.availableCents < 100) return await finish("PENDING_BALANCE", {
          billingStatus: "PENDING_BALANCE", lastError: "CONNECT_INSUFFICIENT_AVAILABLE_BALANCE",
          exportNextAttemptAt: new Date(now.getTime() + 60 * 60_000) });
        // Persist before contacting Stripe. A lost lease cannot create.
        const saved = await db.pinAIReservationFee.updateMany({ where: { reservationId, exportLeaseToken: token },
          data: { debitStartedAt: now } });
        if (saved.count !== 1) return "LEASE_LOST";
      }
      // Once a create is uncertain, bypass balance/account preflight and replay
      // only the pinned request. It may already have deducted the dollar.
      payment = await provider.create(current, pinAIConnectDebitKey(reservationId, current.debitGeneration));
      }
    }
    if (!payment.id.startsWith("py_") || payment.accountId !== current.stripeConnectedAccountId ||
      payment.amount !== 100 || payment.currency !== "usd" || !payment.paid || payment.status !== "succeeded" ||
      payment.metadata.pinAIReservationId !== reservationId || payment.metadata.organizationId !== current.organizationId ||
      payment.metadata.propertyId !== current.propertyId || payment.metadata.pinAITermsVersion !== current.termsVersion)
      return await review("CONNECT_PAYMENT_SCOPE_INVALID");
    return await finish("PAID", { billingStatus: "PAID", stripeDebitPaymentId: payment.id,
      paidAt: now, lastError: null, exportNextAttemptAt: null });
  } catch (error) {
    // Only Stripe's definitive no-funds rejection can retire a request key.
    // Network/5xx/persistence failures never advance the generation.
    if (error instanceof ConnectDebitInsufficientBalanceError) return await finish("PENDING_BALANCE", {
      billingStatus: "PENDING_BALANCE", debitStartedAt: null, debitGeneration: { increment: 1 },
      lastError: "CONNECT_INSUFFICIENT_AVAILABLE_BALANCE",
      exportNextAttemptAt: new Date(now.getTime() + 60 * 60_000) });
    // Preserve debitStartedAt after any ambiguous result, including a DB write
    // failure after Stripe succeeded. Never issue a new key or clear evidence.
    return await finish("RETRY_PENDING", { billingStatus: recoverExpired ? "PENDING_CONNECT" : current.billingStatus,
      lastError: "CONNECT_PROVIDER_OR_PERSISTENCE_UNCERTAIN",
      exportNextAttemptAt: new Date(now.getTime() + 60_000) });
  }
}
