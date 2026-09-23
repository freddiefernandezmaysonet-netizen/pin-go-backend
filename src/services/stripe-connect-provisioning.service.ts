import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import type Stripe from "stripe";

type Database = Pick<PrismaClient, "organization" | "stripeConnectProvisioning" | "$transaction">;
type Dependencies = {
  db: Database;
  stripe: Pick<Stripe, "accounts">;
  params: Stripe.AccountCreateParams;
  validate: (account: Stripe.Account | Stripe.DeletedAccount, id: string) => Stripe.Account;
};

function blocked(code: string): never {
  throw Object.assign(new Error("Stripe account setup requires review. No additional account was created."), { code, statusCode: 409 });
}

/** Persist before the external call. A failed/unknown call is NEVER replayed:
 * Stripe's idempotency retention is finite. Saved account results can be safely
 * attached on a later request; missing results need explicit reconciliation.
 */
export async function provisionStripeConnectAccount(organizationId: string, deps: Dependencies) {
  const { db, stripe, validate } = deps;
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (org.stripeConnectAccountId) {
    return validate(await stripe.accounts.retrieve(org.stripeConnectAccountId), org.stripeConnectAccountId);
  }
  let attempt = await db.stripeConnectProvisioning.findUnique({ where: { organizationId } });
  if (!attempt) {
    try {
      attempt = await db.stripeConnectProvisioning.create({ data: {
        organizationId,
        idempotencyKey: `pingo-connect-${randomUUID()}`,
        request: JSON.parse(JSON.stringify(deps.params)) as Prisma.InputJsonValue,
      } });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") blocked("STRIPE_CONNECT_CREATION_IN_PROGRESS");
      throw error;
    }
    try {
      const account = await stripe.accounts.create(deps.params, { idempotencyKey: attempt.idempotencyKey });
      validate(account, account.id);
      attempt = await db.stripeConnectProvisioning.update({ where: { organizationId }, data: {
        state: "ACCOUNT_CREATED", accountId: account.id,
      } });
    } catch {
      // CLAIMED itself is also fail-closed if this update or the process fails.
      await db.stripeConnectProvisioning.updateMany({ where: { organizationId, state: "CLAIMED" }, data: { state: "REVIEW_REQUIRED" } });
      blocked("STRIPE_CONNECT_CREATION_REVIEW_REQUIRED");
    }
  }
  if (!attempt.accountId || !["ACCOUNT_CREATED", "ATTACHED"].includes(attempt.state)) {
    blocked("STRIPE_CONNECT_CREATION_REVIEW_REQUIRED");
  }
  const account = validate(await stripe.accounts.retrieve(attempt.accountId), attempt.accountId);
  await db.$transaction(async tx => {
    const attached = await tx.organization.updateMany({
      where: { id: organizationId, OR: [{ stripeConnectAccountId: null }, { stripeConnectAccountId: account.id }] },
      data: {
        stripeConnectAccountId: account.id,
        stripeConnectStatus: account.requirements?.disabled_reason ? "RESTRICTED" :
          account.charges_enabled && account.payouts_enabled ? "READY" : account.details_submitted ? "PENDING_VERIFICATION" : "ONBOARDING_REQUIRED",
        stripeConnectChargesEnabled: Boolean(account.charges_enabled),
        stripeConnectPayoutsEnabled: Boolean(account.payouts_enabled),
        stripeConnectDetailsSubmitted: Boolean(account.details_submitted),
        stripeConnectLastSyncedAt: new Date(),
      },
    });
    if (attached.count !== 1) blocked("STRIPE_CONNECT_ACCOUNT_BINDING_CONFLICT");
    await tx.stripeConnectProvisioning.update({ where: { organizationId }, data: { state: "ATTACHED" } });
  });
  return account;
}
