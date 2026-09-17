import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const prisma = new PrismaClient();

const ISOLATION_V2_FLAG = "STRIPE_CONNECT_ISOLATION_V2_ENABLED";
const V2_ACCOUNT_CREATION_FLAG =
  "STRIPE_CONNECT_V2_ACCOUNT_CREATION_ENABLED";

type AccountSessionComponentsCompat =
  Stripe.AccountSessionCreateParams["components"] & {
    account_management?: {
      enabled: boolean;
      features?: {
        external_account_collection?: boolean;
      };
    };
    notification_banner?: {
      enabled: boolean;
      features?: {
        external_account_collection?: boolean;
      };
    };
  };

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

export function isStripeConnectV2AccountCreationEnabled(
  env: NodeJS.ProcessEnv = process.env
) {
  return String(env[V2_ACCOUNT_CREATION_FLAG] ?? "")
    .trim()
    .toLowerCase() === "true";
}

function normalizeConnectCountry(country?: string | null) {
  const normalized = String(country ?? "").trim().toUpperCase();

  if (!normalized) return "US";

  const aliases: Record<string, string> = {
    US: "US",
    USA: "US",
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US",
    PR: "US",
    "PUERTO RICO": "US",
  };

  if (aliases[normalized]) return aliases[normalized];
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  return "US";
}

function serializeStripeJson(value: unknown) {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value));
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
    country: normalizeConnectCountry(input.country),
    controller: {
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
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

export function buildStripeConnectIsolationV2AccountSessionParams(
  accountId: string
): Stripe.AccountSessionCreateParams {
  // Pin&Go currently uses stripe-node 14.x. Stripe's current Account Session API
  // documents account_management and notification_banner, but those two keys
  // predate the installed SDK's generated TypeScript surface. Keep the bridge
  // narrow and document-exact rather than weakening the whole call to `any`.
  const components: AccountSessionComponentsCompat = {
    account_onboarding: {
      enabled: true,
      features: {
        external_account_collection: true,
      },
    },
    account_management: {
      enabled: true,
      features: {
        external_account_collection: true,
      },
    },
    notification_banner: {
      enabled: true,
    },
    documents: {
      enabled: true,
    },
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
  };

  return {
    account: accountId,
    components: components as Stripe.AccountSessionCreateParams["components"],
  };
}

export async function createStripeConnectIsolationV2Account(
  organizationId: string
) {
  if (!isStripeConnectV2AccountCreationEnabled()) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_V2_ACCOUNT_CREATION_DISABLED",
      "Stripe Connect V2 account creation is not enabled.",
      404
    );
  }

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      stripeConnectAccountId: true,
      properties: {
        where: { status: "ACTIVE" },
        select: { country: true },
        take: 1,
      },
    },
  });

  if (!organization) {
    throw new StripeConnectIsolationV2Error(
      "ORGANIZATION_NOT_FOUND",
      "Organization not found.",
      404
    );
  }

  if (organization.stripeConnectAccountId) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_ACCOUNT_ALREADY_EXISTS",
      "This organization already has a Stripe connected account."
    );
  }

  const stripe = getStripeClient();
  const account = await stripe.accounts.create(
    buildStripeConnectIsolationV2AccountCreateParams({
      organizationId: organization.id,
      organizationName: organization.name,
      country: organization.properties[0]?.country ?? "US",
    })
  );

  const stripeOrganizationId = String(
    account.metadata?.organizationId ?? ""
  ).trim();

  if (stripeOrganizationId !== organization.id) {
    throw new StripeConnectIsolationV2Error(
      "STRIPE_CONNECT_TENANT_MISMATCH",
      "Stripe returned a connected account without the expected organization binding.",
      502
    );
  }

  await prisma.organization.update({
    where: { id: organization.id },
    data: {
      stripeConnectAccountId: account.id,
      stripeConnectStatus: account.details_submitted
        ? "PENDING_VERIFICATION"
        : "ONBOARDING_REQUIRED",
      stripeConnectChargesEnabled: Boolean(account.charges_enabled),
      stripeConnectPayoutsEnabled: Boolean(account.payouts_enabled),
      stripeConnectDetailsSubmitted: Boolean(account.details_submitted),
      stripeConnectRequirements: serializeStripeJson(account.requirements),
      stripeConnectDisabledReason: account.requirements?.disabled_reason ?? null,
      stripeConnectLastSyncedAt: new Date(),
    },
  });

  return {
    accountId: account.id,
    accountDisplayId: `acct_••••${account.id.slice(-4)}`,
    organizationId: organization.id,
    organizationName: organization.name,
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

  const session = await stripe.accountSessions.create(
    buildStripeConnectIsolationV2AccountSessionParams(account.id)
  );

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
