import {
  DamageCasePaymentAttemptStatus,
  DamageCaseStatus,
  type PrismaClient,
} from "@prisma/client";
import type Stripe from "stripe";
import { damageCasePaymentFlow } from "./damage-case-payment-execution.service.js";

const supported = new Set([
  "payment_intent.succeeded",
  "payment_intent.processing",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function safeText(value: unknown, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function status(paymentIntent: Stripe.PaymentIntent) {
  switch (paymentIntent.status) {
    case "succeeded":
      return DamageCasePaymentAttemptStatus.SUCCEEDED;
    case "requires_action":
    case "requires_confirmation":
      return DamageCasePaymentAttemptStatus.REQUIRES_ACTION;
    case "requires_payment_method":
      return DamageCasePaymentAttemptStatus.FAILED;
    case "canceled":
      return DamageCasePaymentAttemptStatus.CANCELED;
    default:
      return DamageCasePaymentAttemptStatus.PROCESSING;
  }
}

export async function reconcileDamageCasePaymentIntent(
  prisma: PrismaClient,
  event: Stripe.Event,
  now = new Date()
) {
  if (!supported.has(event.type))
    return { handled: false as const, reason: "EVENT_NOT_SUPPORTED" as const };

  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  if (paymentIntent.metadata?.flow !== damageCasePaymentFlow)
    return { handled: false as const, reason: "FLOW_NOT_MATCHED" as const };

  const damageCaseId = String(paymentIntent.metadata.damageCaseId ?? "").trim();
  const claimRevision = String(paymentIntent.metadata.claimRevision ?? "").trim();
  const paymentAuthorizationId = String(
    paymentIntent.metadata.paymentAuthorizationId ?? ""
  ).trim();
  const connectedAccountId = String(event.account ?? "").trim();
  if (!damageCaseId || !claimRevision || !paymentAuthorizationId || !connectedAccountId)
    throw new Error("DAMAGE_PAYMENT_WEBHOOK_SCOPE_MISSING");

  return prisma.$transaction(async (db) => {
    const attempt = await db.damageCasePaymentAttempt.findUnique({
      where: { damageCaseId },
    });
    if (!attempt) throw new Error("DAMAGE_PAYMENT_ATTEMPT_NOT_FOUND");
    if (
      attempt.paymentAuthorizationId !== paymentAuthorizationId ||
      attempt.claimRevision !== claimRevision ||
      attempt.connectedAccountId !== connectedAccountId ||
      attempt.amountMinor !== paymentIntent.amount ||
      attempt.currency !== paymentIntent.currency ||
      (attempt.stripePaymentIntentId &&
        attempt.stripePaymentIntentId !== paymentIntent.id)
    ) throw new Error("DAMAGE_PAYMENT_WEBHOOK_SCOPE_MISMATCH");

    const nextStatus = status(paymentIntent);
    if (attempt.status === DamageCasePaymentAttemptStatus.SUCCEEDED) {
      await db.damageCase.updateMany({
        where: {
          id: attempt.damageCaseId,
          status: DamageCaseStatus.GUEST_NOTIFIED,
        },
        data: { status: DamageCaseStatus.CHARGED },
      });
      const damageCase = await db.damageCase.findUniqueOrThrow({
        where: { id: attempt.damageCaseId },
        select: { status: true },
      });
      if (damageCase.status !== DamageCaseStatus.CHARGED)
        throw new Error("DAMAGE_PAYMENT_SUCCEEDED_CASE_RECONCILIATION_REQUIRED");
      return { handled: true as const, idempotent: true, status: attempt.status };
    }

    const lastError = paymentIntent.last_payment_error;
    const updated = await db.damageCasePaymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: nextStatus,
        stripePaymentIntentId: paymentIntent.id,
        stripeChargeId: objectId(paymentIntent.latest_charge),
        providerStatus: paymentIntent.status,
        failureCode: safeText(lastError?.code, 120),
        declineCode: safeText(lastError?.decline_code, 120),
        failureMessage: safeText(lastError?.message),
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        succeededAt:
          nextStatus === DamageCasePaymentAttemptStatus.SUCCEEDED
            ? now
            : attempt.succeededAt,
        failedAt:
          nextStatus === DamageCasePaymentAttemptStatus.FAILED ||
          nextStatus === DamageCasePaymentAttemptStatus.CANCELED
            ? now
            : null,
      },
    });

    if (nextStatus === DamageCasePaymentAttemptStatus.SUCCEEDED) {
      await db.damageCase.updateMany({
        where: {
          id: attempt.damageCaseId,
          status: DamageCaseStatus.GUEST_NOTIFIED,
        },
        data: { status: DamageCaseStatus.CHARGED },
      });
      const damageCase = await db.damageCase.findUniqueOrThrow({
        where: { id: attempt.damageCaseId },
        select: { status: true },
      });
      if (damageCase.status !== DamageCaseStatus.CHARGED)
        throw new Error("DAMAGE_PAYMENT_SUCCEEDED_CASE_RECONCILIATION_REQUIRED");
    }

    return { handled: true as const, idempotent: false, status: updated.status };
  });
}
