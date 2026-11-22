import type { Prisma, PrismaClient } from "@prisma/client";

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

// Called only after retrieving the current subscription from Stripe. Use the
// signed event's timestamp so webhook retries cannot move the grace window.
export async function persistSubscriptionWithGrace(
  db: Pick<PrismaClient, "$transaction">,
  args: Prisma.SubscriptionUpsertArgs,
  observedAt: Date,
) {
  if (!Number.isFinite(observedAt.getTime())) throw new Error("INVALID_SUBSCRIPTION_EVENT_TIME");
  const pastDue = args.create.status === "PAST_DUE";
  const deadline = new Date(observedAt.getTime() + FIVE_DAYS_MS);
  const organizationId = args.create.organizationId;
  const subscriptionId = args.create.stripeSubscriptionId;
  if (!organizationId || !subscriptionId) throw new Error("MISSING_SUBSCRIPTION_GRACE_SCOPE");
  await db.$transaction(async tx => {
    // A replacement subscription must not inherit another subscription's debt.
    // The conditional write also serializes concurrent replacement events.
    await tx.subscription.updateMany({
      where: { organizationId, stripeSubscriptionId: { not: subscriptionId } },
      data: { graceUntil: null },
    });
    await tx.subscription.upsert({
      ...args,
      create: { ...args.create, graceUntil: pastDue ? deadline : null },
      // Preserve the first overdue deadline; recovery clears it so a later
      // independent missed payment can receive its own grace period.
      update: { ...args.update, ...(pastDue ? {} : { graceUntil: null }) },
    });
    if (pastDue) {
      await tx.subscription.updateMany({
        where: {
          organizationId,
          stripeSubscriptionId: subscriptionId,
          status: "PAST_DUE", graceUntil: null,
        },
        data: { graceUntil: deadline },
      });
    }
    if (args.create.status === "ACTIVE" || args.create.status === "TRIALING") {
      // A recovered payment only requeues grants blocked by this billing gate.
      // The worker still owns readiness, identity checks and hardware access.
      await tx.accessGrant.updateMany({
        where: {
          type: "GUEST", method: "PASSCODE_TIMEBOUND", status: "SUSPENDED",
          lastError: { startsWith: "Blocked by billing: " },
          endsAt: { gt: observedAt },
          reservation: {
            status: "ACTIVE", paymentState: "PAID", checkOut: { gt: observedAt },
            property: { organizationId },
          },
        },
        data: { status: "PENDING", lastError: null },
      });
    }
  });
}
