import type Stripe from "stripe";
import type { PrismaClient } from "@prisma/client";

const FINANCIAL_EVENT_PREFIXES = [
  "checkout.session.",
  "customer.subscription.",
  "invoice.",
  "payment_intent.",
  "charge.",
  "refund.",
  "application_fee.",
  "transfer.",
  "payout.",
] as const;

type StripeEventLogDb = Pick<PrismaClient, "stripeEventLog">;

export type StripeFinancialEventLedgerClaim = {
  tracked: boolean;
  shouldProcess: boolean;
  reason:
    | "NOT_FINANCIAL"
    | "NEW"
    | "RETRY"
    | "DUPLICATE_PROCESSED"
    | "DUPLICATE_IN_PROGRESS";
};

export function isStripeFinancialLedgerEventType(type: string) {
  return FINANCIAL_EVENT_PREFIXES.some((prefix) =>
    type.startsWith(prefix)
  );
}

function serializeStripeEvent(event: Stripe.Event) {
  return JSON.parse(JSON.stringify(event));
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
  );
}

function normalizeLedgerError(error: unknown) {
  const value =
    error instanceof Error
      ? error.message
      : String(error ?? "Unknown Stripe webhook processing error");

  return value.trim().slice(0, 2000) || "Unknown Stripe webhook processing error";
}

export async function claimStripeFinancialEvent(
  db: StripeEventLogDb,
  event: Stripe.Event
): Promise<StripeFinancialEventLedgerClaim> {
  if (!isStripeFinancialLedgerEventType(event.type)) {
    return {
      tracked: false,
      shouldProcess: true,
      reason: "NOT_FINANCIAL",
    };
  }

  const payload = serializeStripeEvent(event);

  try {
    await db.stripeEventLog.create({
      data: {
        stripeId: event.id,
        type: event.type,
        livemode: event.livemode,
        payload,
        processedAt: null,
        error: null,
      },
    });

    return {
      tracked: true,
      shouldProcess: true,
      reason: "NEW",
    };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
  }

  const existing = await db.stripeEventLog.findUnique({
    where: {
      stripeId: event.id,
    },
    select: {
      processedAt: true,
      error: true,
    },
  });

  if (!existing) {
    throw new Error("STRIPE_EVENT_LEDGER_DUPLICATE_ROW_NOT_FOUND");
  }

  if (existing.processedAt) {
    return {
      tracked: true,
      shouldProcess: false,
      reason: "DUPLICATE_PROCESSED",
    };
  }

  if (!existing.error) {
    return {
      tracked: true,
      shouldProcess: false,
      reason: "DUPLICATE_IN_PROGRESS",
    };
  }

  const reclaimed = await db.stripeEventLog.updateMany({
    where: {
      stripeId: event.id,
      processedAt: null,
      error: {
        not: null,
      },
    },
    data: {
      type: event.type,
      livemode: event.livemode,
      payload,
      error: null,
    },
  });

  if (reclaimed.count !== 1) {
    return {
      tracked: true,
      shouldProcess: false,
      reason: "DUPLICATE_IN_PROGRESS",
    };
  }

  return {
    tracked: true,
    shouldProcess: true,
    reason: "RETRY",
  };
}

export async function markStripeFinancialEventProcessed(
  db: StripeEventLogDb,
  stripeId: string,
  processedAt = new Date()
) {
  await db.stripeEventLog.update({
    where: {
      stripeId,
    },
    data: {
      processedAt,
      error: null,
    },
  });
}

export async function markStripeFinancialEventFailed(
  db: StripeEventLogDb,
  stripeId: string,
  error: unknown
) {
  await db.stripeEventLog.update({
    where: {
      stripeId,
    },
    data: {
      processedAt: null,
      error: normalizeLedgerError(error),
    },
  });
}
