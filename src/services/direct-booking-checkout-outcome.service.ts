import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type Stripe from "stripe";

export const PAID_AVAILABILITY_CASE_CODE = "DIRECT_BOOKING_PAID_AVAILABILITY_CONFLICT";
export const PAID_CHECKOUT_REVIEW_WON = "DIRECT_BOOKING_PAID_CONFLICT_CASE_EXISTS";

function hash(parts: string[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Only call on a signature-verified Stripe event delivered to this webhook. */
export function getPaidDirectBookingCheckoutScope(event: Stripe.Event, session: Stripe.Checkout.Session) {
  const account = event.account;
  const { flow, stripeChargeMode, stripeConnectedAccountId, propertyId, organizationId } =
    session.metadata ?? {};
  const amountCents = session.amount_total;
  const currency = session.currency;

  if (
    (event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded") ||
    session.mode !== "payment" || session.payment_status !== "paid" ||
    flow !== "direct_booking" || stripeChargeMode !== "DIRECT_CHARGE" ||
    !account?.startsWith("acct_") || account !== stripeConnectedAccountId ||
    !session.id.startsWith("cs_") || !propertyId || !organizationId ||
    typeof amountCents !== "number" ||
    !Number.isSafeInteger(amountCents) || amountCents <= 0 ||
    !currency || !/^[a-z]{3}$/.test(currency)
  ) return null;

  const key = hash([account, session.id]);
  return {
    key,
    eventKey: hash([account, session.id, event.id]),
    operationalKey: `${PAID_AVAILABILITY_CASE_CODE}:${key}`,
    account,
    sessionId: session.id,
    propertyId,
    organizationId,
    amountCents,
    currency,
  };
}

export type PaidDirectBookingCheckoutScope =
  NonNullable<ReturnType<typeof getPaidDirectBookingCheckoutScope>>;

type Decision = "BOOKED" | "REVIEW";

export async function claimPaidDirectBookingDecision(
  tx: Prisma.TransactionClient,
  scope: PaidDirectBookingCheckoutScope,
  decision: Decision
) {
  // Atomic unique-key arbitration. Never claim outside the transaction which
  // writes the corresponding reservation or case. Serializable conflicts from
  // a concurrent INSERT must escape to the existing bounded DB retry loop.
  const row = {
    key: scope.key, decision, organizationId: scope.organizationId, propertyId: scope.propertyId,
    bookingEventKey: decision === "BOOKED" ? scope.eventKey : null,
  };
  const inserted = await tx.directBookingCheckoutOutcome.createMany({
    data: row,
    skipDuplicates: true,
  });
  if (inserted.count === 1) return row;

  const prior = await tx.directBookingCheckoutOutcome.findUnique({ where: { key: scope.key } });
  if (!prior || prior.organizationId !== scope.organizationId || prior.propertyId !== scope.propertyId) {
    throw new Error("DIRECT_BOOKING_CHECKOUT_OUTCOME_SCOPE_MISMATCH");
  }
  return prior;
}

export async function claimPaidDirectBookingIngest(
  tx: Prisma.TransactionClient,
  scope: PaidDirectBookingCheckoutScope,
  propertyId: string,
  externalId: string | null,
  externalProvider: string | null
) {
  if (propertyId !== scope.propertyId || externalId !== scope.sessionId ||
    externalProvider !== "PIN_GO_DIRECT") {
    throw new Error("DIRECT_BOOKING_CHECKOUT_INGEST_SCOPE_MISMATCH");
  }
  // Respect a case that predates the outcome fence, including already resolved.
  const priorCase = await tx.operationalIssue.findUnique({
    where: { operationalKey: scope.operationalKey },
    select: { issueCode: true, propertyId: true, organizationId: true },
  });
  if (priorCase) {
    if (priorCase.issueCode !== PAID_AVAILABILITY_CASE_CODE ||
      priorCase.propertyId !== scope.propertyId || priorCase.organizationId !== scope.organizationId) {
      throw new Error("DIRECT_BOOKING_PAID_CONFLICT_CASE_SCOPE_MISMATCH");
    }
    throw new Error(PAID_CHECKOUT_REVIEW_WON);
  }

  const outcome = await claimPaidDirectBookingDecision(tx, scope, "BOOKED");
  if (outcome.decision === "REVIEW") throw new Error(PAID_CHECKOUT_REVIEW_WON);
  if (outcome.bookingEventKey !== scope.eventKey) {
    // Do not let a different Stripe event re-run post-commit booking work while
    // the first event is still attaching session details or delivering messages.
    throw new Error("DIRECT_BOOKING_CHECKOUT_BOOKING_EVENT_ALREADY_CLAIMED");
  }
}

/** Resume enrichment only for the same ledger event that atomically committed
 * the exact PAID/ACTIVE ingest tuple, without running ingest a second time. */
export async function findOwnedPaidDirectBookingIngest(
  db: Pick<PrismaClient, "directBookingCheckoutOutcome" | "reservation">,
  scope: PaidDirectBookingCheckoutScope,
  checkIn: Date,
  checkOut: Date
) {
  const outcome = await db.directBookingCheckoutOutcome.findUnique({ where: { key: scope.key } });
  if (!outcome || outcome.decision !== "BOOKED" || outcome.bookingEventKey !== scope.eventKey) return null;
  if (outcome.organizationId !== scope.organizationId || outcome.propertyId !== scope.propertyId) {
    throw new Error("DIRECT_BOOKING_CHECKOUT_OUTCOME_SCOPE_MISMATCH");
  }

  const reservation = await db.reservation.findUnique({
    where: { propertyId_externalProvider_externalId: {
      propertyId: scope.propertyId, externalProvider: "PIN_GO_DIRECT", externalId: scope.sessionId,
    } },
    select: { id: true, checkIn: true, checkOut: true, paymentState: true, status: true, stripeCheckoutSessionId: true },
  });
  if (!reservation || reservation.paymentState !== "PAID" || reservation.status !== "ACTIVE" ||
    reservation.checkIn.getTime() !== checkIn.getTime() || reservation.checkOut.getTime() !== checkOut.getTime() ||
    (reservation.stripeCheckoutSessionId !== null && reservation.stripeCheckoutSessionId !== scope.sessionId)) {
    throw new Error("DIRECT_BOOKING_CHECKOUT_OWNED_RESERVATION_NOT_RECOVERABLE");
  }
  return reservation;
}
