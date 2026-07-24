import { PrismaClient } from "@prisma/client";
import type { Organization, StripeConnectStatus } from "@prisma/client";
import Stripe from "stripe";

const prisma = new PrismaClient();

const STRIPE_CONNECT_STATUS = {
  NOT_CONNECTED: "NOT_CONNECTED",
  ONBOARDING_REQUIRED: "ONBOARDING_REQUIRED",
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
  READY: "READY",
  RESTRICTED: "RESTRICTED",
} as const satisfies Record<StripeConnectStatus, StripeConnectStatus>;

export type OrganizationPayoutStatus = {
  organizationId: string;
  stripeConnectAccountId: string | null;
  status: StripeConnectStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
  requirements: unknown;
  lastSyncedAt: Date | null;
  canAcceptDirectBookingPayments: boolean;
};

export class HostPayoutNotReadyError extends Error {
  statusCode = 409;
  code = "HOST_PAYOUT_NOT_READY";
  details: OrganizationPayoutStatus;

  constructor(details: OrganizationPayoutStatus) {
    super(
      "Host payout setup is not ready. Direct Booking payments are blocked until Stripe Connect onboarding is completed."
    );
    this.name = "HostPayoutNotReadyError";
    this.details = details;
  }
}

let stripeClient: Stripe | null = null;

function getStripeClient() {
  if (!stripeClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY;

    if (!secretKey) {
      throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
    }

    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
}

function getDashboardBaseUrl() {
  const rawBaseUrl =
    process.env.STRIPE_CONNECT_DASHBOARD_URL ||
    process.env.DASHBOARD_URL ||
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    "http://localhost:5173";

  return rawBaseUrl.replace(/\/$/, "");
}

function getStripeConnectReturnUrl() {
  return (
    process.env.STRIPE_CONNECT_RETURN_URL ||
    `${getDashboardBaseUrl()}/dashboard/payouts?stripe_connect=return`
  );
}

function getStripeConnectRefreshUrl() {
  return (
    process.env.STRIPE_CONNECT_REFRESH_URL ||
    `${getDashboardBaseUrl()}/dashboard/payouts?stripe_connect=refresh`
  );
}

function normalizeConnectCountry(country?: string | null) {
  const normalized = country?.trim().toUpperCase();

  if (!normalized) return "US";

  const aliases: Record<string, string> = {
    US: "US",
    USA: "US",
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US",
    PR: "US",
    "PUERTO RICO": "US",
  };

  if (aliases[normalized]) {
    return aliases[normalized];
  }

  if (/^[A-Z]{2}$/.test(normalized)) {
    return normalized;
  }

  return "US";
}

function serializeStripeJson(value: unknown) {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value));
}

export function mapStripeAccountStatus(
  account: Stripe.Account
): StripeConnectStatus {
  const disabledReason = account.requirements?.disabled_reason;

  if (disabledReason) {
    return STRIPE_CONNECT_STATUS.RESTRICTED;
  }

  if (account.charges_enabled && account.payouts_enabled) {
    return STRIPE_CONNECT_STATUS.READY;
  }

  if (!account.details_submitted) {
    return STRIPE_CONNECT_STATUS.ONBOARDING_REQUIRED;
  }

  return STRIPE_CONNECT_STATUS.PENDING_VERIFICATION;
}

function toOrganizationPayoutStatus(
  organization: Organization
): OrganizationPayoutStatus {
  const canAcceptDirectBookingPayments =
    organization.stripeConnectStatus === STRIPE_CONNECT_STATUS.READY &&
    organization.stripeConnectChargesEnabled &&
    organization.stripeConnectPayoutsEnabled &&
    Boolean(organization.stripeConnectAccountId);

  return {
    organizationId: organization.id,
    stripeConnectAccountId: organization.stripeConnectAccountId,
    status: organization.stripeConnectStatus,
    chargesEnabled: organization.stripeConnectChargesEnabled,
    payoutsEnabled: organization.stripeConnectPayoutsEnabled,
    detailsSubmitted: organization.stripeConnectDetailsSubmitted,
    disabledReason: organization.stripeConnectDisabledReason,
    requirements: organization.stripeConnectRequirements,
    lastSyncedAt: organization.stripeConnectLastSyncedAt,
    canAcceptDirectBookingPayments,
  };
}

async function updateOrganizationFromStripeAccount(
  organizationId: string,
  account: Stripe.Account,
  syncedAt: Date = new Date()
) {
  const status = mapStripeAccountStatus(account);

  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: {
      stripeConnectAccountId: account.id,
      stripeConnectStatus: status,
      stripeConnectChargesEnabled: Boolean(account.charges_enabled),
      stripeConnectPayoutsEnabled: Boolean(account.payouts_enabled),
      stripeConnectDetailsSubmitted: Boolean(account.details_submitted),
      stripeConnectRequirements: serializeStripeJson(account.requirements),
      stripeConnectDisabledReason: account.requirements?.disabled_reason ?? null,
      stripeConnectLastSyncedAt: syncedAt,
    },
  });

  return toOrganizationPayoutStatus(organization);
}

function getAccountMetadataOrganizationId(
  account: Stripe.Account
) {
  const organizationId = String(
    account.metadata?.organizationId ?? ""
  ).trim();

  return organizationId || null;
}

export async function syncConnectAccountStatusFromWebhook(
  account: Stripe.Account,
  occurredAt: Date = new Date()
) {
  const organizationByAccount =
    await prisma.organization.findUnique({
      where: {
        stripeConnectAccountId: account.id,
      },
    });

  if (organizationByAccount) {
    return updateOrganizationFromStripeAccount(
      organizationByAccount.id,
      account,
      occurredAt
    );
  }

  const metadataOrganizationId =
    getAccountMetadataOrganizationId(account);

  if (!metadataOrganizationId) {
    console.warn(
      "[STRIPE_CONNECT_ACCOUNT_WEBHOOK_SKIPPED]",
      {
        accountId: account.id,
        reason:
          "ORGANIZATION_REFERENCE_NOT_FOUND",
      }
    );

    return null;
  }

  const organizationByMetadata =
    await prisma.organization.findUnique({
      where: {
        id: metadataOrganizationId,
      },
    });

  if (!organizationByMetadata) {
    console.warn(
      "[STRIPE_CONNECT_ACCOUNT_WEBHOOK_SKIPPED]",
      {
        accountId: account.id,
        organizationId:
          metadataOrganizationId,
        reason: "ORGANIZATION_NOT_FOUND",
      }
    );

    return null;
  }

  if (
    organizationByMetadata.stripeConnectAccountId &&
    organizationByMetadata.stripeConnectAccountId !== account.id
  ) {
    console.error(
      "[STRIPE_CONNECT_ACCOUNT_WEBHOOK_OWNERSHIP_MISMATCH]",
      {
        accountId: account.id,
        organizationId:
          organizationByMetadata.id,
        configuredAccountId:
          organizationByMetadata.stripeConnectAccountId,
      }
    );

    return null;
  }

  return updateOrganizationFromStripeAccount(
    organizationByMetadata.id,
    account,
    occurredAt
  );
}

async function getOrganizationForConnect(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      dashboardUsers: {
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
      properties: {
        where: { status: "ACTIVE" },
        select: { country: true },
        take: 1,
      },
    },
  });

  if (!organization) {
    throw new Error(`Organization not found: ${organizationId}`);
  }

  return organization;
}

export async function getOrganizationPayoutStatus(
  organizationId: string,
  options: { syncWithStripe?: boolean } = {}
) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
  });

  if (!organization) {
    throw new Error(`Organization not found: ${organizationId}`);
  }

  if (options.syncWithStripe && organization.stripeConnectAccountId) {
    return syncConnectAccountStatus(organizationId);
  }

  return toOrganizationPayoutStatus(organization);
}

export async function createOrGetConnectAccount(organizationId: string) {
  const organization = await getOrganizationForConnect(organizationId);

  if (organization.stripeConnectAccountId) {
    return syncConnectAccountStatus(organizationId);
  }

  const stripe = getStripeClient();

  const primaryUser = organization.dashboardUsers[0];
  const primaryProperty = organization.properties[0];

  const account = await stripe.accounts.create({
    type: "express",
    country: normalizeConnectCountry(primaryProperty?.country),
    email: primaryUser?.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      name: organization.name,
      product_description:
        "Short-term rental direct booking payouts powered by Pin&Go.",
    },
    metadata: {
      organizationId: organization.id,
      platform: "PinGo",
      product: "Host Payouts V1",
    },
  });

  return updateOrganizationFromStripeAccount(organization.id, account);
}

export async function createConnectOnboardingLink(organizationId: string) {
  const payoutStatus = await createOrGetConnectAccount(organizationId);

  if (!payoutStatus.stripeConnectAccountId) {
    throw new Error("Stripe Connect account was not created.");
  }

  const stripe = getStripeClient();

  const accountLink = await stripe.accountLinks.create({
    account: payoutStatus.stripeConnectAccountId,
    refresh_url: getStripeConnectRefreshUrl(),
    return_url: getStripeConnectReturnUrl(),
    type: "account_onboarding",
  });

  return {
    url: accountLink.url,
    expiresAt: accountLink.expires_at,
    accountId: payoutStatus.stripeConnectAccountId,
    payoutStatus,
  };
}

export async function syncConnectAccountStatus(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
  });

  if (!organization) {
    throw new Error(`Organization not found: ${organizationId}`);
  }

  if (!organization.stripeConnectAccountId) {
    return toOrganizationPayoutStatus(organization);
  }

  const stripe = getStripeClient();

  const account = await stripe.accounts.retrieve(
    organization.stripeConnectAccountId
  );

  return updateOrganizationFromStripeAccount(organization.id, account);
}

export async function assertDirectBookingPayoutReady(organizationId: string) {
  const payoutStatus = await getOrganizationPayoutStatus(organizationId, {
    syncWithStripe: true,
  });

  if (
    !payoutStatus.canAcceptDirectBookingPayments ||
    !payoutStatus.stripeConnectAccountId
  ) {
    throw new HostPayoutNotReadyError(payoutStatus);
  }

  return {
    connectedAccountId: payoutStatus.stripeConnectAccountId,
    payoutStatus,
  };
}
