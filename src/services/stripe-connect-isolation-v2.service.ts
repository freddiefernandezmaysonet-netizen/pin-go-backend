import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const prisma = new PrismaClient();

const ISOLATION_V2_FLAG = "STRIPE_CONNECT_ISOLATION_V2_ENABLED";

export class StripeConnectIsolationV2Error extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "StripeConnectIsolationV2Error";
    this.code = code;
    this.statusCode = statusCode;
  }
}

let stripeClient: Stripe | null = null;

function getStripeClient() {
  if (!stripeClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY;

    if (!secretKey) {
      throw new StripeConnectIsolationV2Error(
        "STRIPE_CONNECT_CONFIGURATION_MISSING",
        "Stripe Connect is not configured.",
        503
      );
    }

    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
}

export function isStripeConnectIsolationV2Enabled(
  env: NodeJS.ProcessEnv = process.env
) {
  return String(env[ISOLATION_V2_FLAG] ?? "")
    .trim()
    .toLowerCase() === "true";
}

function asStripeAccount(
  account: Stripe.Account | Stripe.DeletedAccount
): Stripe.Account {
  if ("deleted" in account && account.deleted) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_ACCOUNT_DELETED",
      "The connected Stripe account is no longer available."
    );
  }

  return account as Stripe.Account;
}

export function assertStripeConnectTenantOwnership(input: {
  organizationId: string;
  persistedAccountId: string;
  account: Stripe.Account | Stripe.DeletedAccount;
}) {
  const account = asStripeAccount(input.account);
  const persistedAccountId = String(input.persistedAccountId ?? "").trim();
  const stripeOrganizationId = String(
    account.metadata?.organizationId ?? ""
  ).trim();

  if (!persistedAccountId || account.id !== persistedAccountId) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_ACCOUNT_ID_MISMATCH",
      "The Stripe connected account does not match the organization record."
    );
  }

  if (!stripeOrganizationId) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_TENANT_METADATA_MISSING",
      "The Stripe connected account is missing its Pin&Go organization binding."
    );
  }

  if (stripeOrganizationId !== input.organizationId) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_TENANT_MISMATCH",
      "The Stripe connected account belongs to a different Pin&Go organization."
    );
  }

  return account;
}

export function buildStripeConnectIsolationV2AccountCreateParams(input: {
  organizationId: string;
  organizationName: string;
  country: string;
}): Stripe.AccountCreateParams {
  return {
    country: input.country,
    controller: {
      fees: { payer: "application" },
      losses: { payments: "application" },
      requirement_collection: "application",
      stripe_dashboard: { type: "none" },
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      name: input.organizationName,
      product_description:
        "Short-term rental direct booking payouts powered by Pin&Go.",
    },
    metadata: {
      organizationId: input.organizationId,
      platform: "PinGo",
      product: "Stripe Connect Isolation V2",
    },
  };
}

export async function createStripeConnectIsolationV2AccountSession(
  organizationId: string
) {
  if (!isStripeConnectIsolationV2Enabled()) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_ISOLATION_V2_DISABLED",
      "Stripe Connect Isolation V2 is not enabled.",
      404
    );
  }

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      stripeConnectAccountId: true,
    },
  });

  if (!organization) {
    throw new StripeConnectIsolationV2Error(
      "ORGANIZATION_NOT_FOUND",
      "Organization not found.",
      404
    );
  }

  const persistedAccountId = String(
    organization.stripeConnectAccountId ?? ""
  ).trim();

  if (!persistedAccountId) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_NOT_CONNECTED",
      "This organization does not have a Stripe connected account."
    );
  }

  const stripe = getStripeClient();
  const retrieved = await stripe.accounts.retrieve(persistedAccountId);
  const account = assertStripeConnectTenantOwnership({
    organizationId: organization.id,
    persistedAccountId,
    account: retrieved,
  });

  const session = await stripe.accountSessions.create({
    account: account.id,
    components: {
      payments: {
        enabled: true,
        features: {
          capture_payments: false,
          dispute_management: false,
          refund_management: false,
          destination_on_behalf_of_charge_management: false,
        },
      },
      payouts: {
        enabled: true,
        features: {
          edit_payout_schedule: false,
          instant_payouts: false,
          standard_payouts: false,
        },
      },
    },
  });

  if (session.account !== account.id) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_ACCOUNT_SESSION_MISMATCH",
      "Stripe returned an Account Session for a different connected account.",
      502
    );
  }

  return {
    clientSecret: session.client_secret,
    expiresAt: session.expires_at,
    accountId: account.id,
    accountDisplayId: `acct_••••${account.id.slice(-4)}`,
    organizationId: organization.id,
    organizationName: organization.name,
  };
}
