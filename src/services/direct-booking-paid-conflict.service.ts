import type { Prisma, PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service.js";

import {
  PAID_AVAILABILITY_CASE_CODE as issueCode,
  claimPaidDirectBookingDecision,
  getPaidDirectBookingCheckoutScope,
  type PaidDirectBookingCheckoutScope as Scope,
} from "./direct-booking-checkout-outcome.service.js";
import { runIngestTransaction } from "./direct-booking-ingest-transaction.js";

const availabilityConflict = "DIRECT_BOOKING_PROPERTY_NO_LONGER_AVAILABLE";

async function lockCase(tx: Prisma.TransactionClient, scope: Scope) {
  // Same lock as upsertOperationalIssue, so an existing review or resolution
  // can never be replaced by a later event for this session.
  await tx.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    scope.operationalKey
  );
}

function findCase(db: Pick<PrismaClient, "operationalIssue">, scope: Scope) {
  return db.operationalIssue.findUnique({
    where: { operationalKey: scope.operationalKey },
    select: { id: true, issueCode: true, organizationId: true, propertyId: true },
  });
}

function assertCaseScope(found: NonNullable<Awaited<ReturnType<typeof findCase>>>, scope: Scope) {
  if (found.issueCode !== issueCode ||
    found.organizationId !== scope.organizationId ||
    found.propertyId !== scope.propertyId) {
    throw new Error("DIRECT_BOOKING_PAID_CONFLICT_CASE_SCOPE_MISMATCH");
  }
}

async function getPendingLedgerId(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const row = await tx.stripeEventLog.findUnique({
    where: { stripeId: event.id },
    select: { id: true, type: true, processedAt: true, error: true },
  });
  if (!row || row.processedAt || row.error !== null || row.type !== event.type) {
    throw new Error("DIRECT_BOOKING_PAID_CONFLICT_LEDGER_CLAIM_MISSING");
  }
  return row.id;
}

async function acknowledgeCaseEvent(tx: Prisma.TransactionClient, ledgerId: string) {
  // This is a handled exception, not normal reservation financial reconciliation.
  await tx.stripeEventLog.update({
    where: { id: ledgerId },
    data: { processedAt: new Date(), error: null },
  });
}

export async function acknowledgeExistingPaidDirectBookingConflict(
  prisma: PrismaClient,
  event: Stripe.Event,
  session: Stripe.Checkout.Session
): Promise<boolean> {
  const scope = getPaidDirectBookingCheckoutScope(event, session);
  if (!scope || !(await findCase(prisma, scope))) return false;

  return runIngestTransaction(prisma, "DIRECT_BOOKING", async (tx) => {
    await lockCase(tx, scope);
    const found = await findCase(tx, scope);
    if (!found) throw new Error("DIRECT_BOOKING_PAID_CONFLICT_CASE_MISSING");
    assertCaseScope(found, scope);
    await acknowledgeCaseEvent(tx, await getPendingLedgerId(tx, event));
    return true;
  });
}

export async function recordPaidDirectBookingConflict(
  prisma: PrismaClient,
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  error: unknown
): Promise<boolean> {
  if (!(error instanceof Error) || error.message !== availabilityConflict) {
    return false;
  }
  const scope = getPaidDirectBookingCheckoutScope(event, session);
  if (!scope) return false;

  return runIngestTransaction(prisma, "DIRECT_BOOKING", async (tx) => {
    await lockCase(tx, scope);
    const ledgerId = await getPendingLedgerId(tx, event);
    const found = await findCase(tx, scope);

    if (found) {
      assertCaseScope(found, scope);
    } else {
      const property = await tx.property.findFirst({
        where: {
          id: scope.propertyId,
          organizationId: scope.organizationId,
          organization: { stripeConnectAccountId: scope.account },
        },
        select: { id: true },
      });
      if (!property) return false;

      const booked = await tx.reservation.findUnique({
        where: { stripeCheckoutSessionId: scope.sessionId },
        select: { id: true },
      }) ?? await tx.reservation.findUnique({
        where: { propertyId_externalProvider_externalId: {
          propertyId: scope.propertyId,
          externalProvider: "PIN_GO_DIRECT",
          externalId: scope.sessionId,
        } },
        select: { id: true },
      });
      if (booked) return false;

      const outcome = await claimPaidDirectBookingDecision(tx, scope, "REVIEW");
      if (outcome.decision === "BOOKED") return false;

      await upsertOperationalIssue(tx, {
        operationalKey: scope.operationalKey,
        issueCode,
        title: "Paid Direct Booking could not be reserved",
        issue: "Payment was confirmed, but the requested stay is no longer available.",
        recommendedAction: "Review a full refund first. Confirm the payment and booking status before acting.",
        engine: "DIRECT_BOOKING",
        severity: "CRITICAL",
        workflowState: "ACTION_REQUIRED",
        visibility: "SYSTEM",
        responsibleActor: "PIN_GO",
        actionRequired: true,
        canAutoResolve: false,
        autoResolveStatus: "NOT_SUPPORTED",
        organizationId: scope.organizationId,
        propertyId: scope.propertyId,
        reservationId: null,
        sourceType: "ENGINE_EVENT",
        actionTarget: "PAYMENT",
        transitionCode: issueCode,
        transitionSummary: "Paid booking conflict requires manual review.",
        transitionedBy: "SYSTEM",
        metadata: { stripeEventLogId: ledgerId, amountCents: scope.amountCents, currency: scope.currency },
      });
    }

    await acknowledgeCaseEvent(tx, ledgerId);
    return true;
  });
}
