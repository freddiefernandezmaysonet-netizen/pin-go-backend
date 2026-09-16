import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const prisma = new PrismaClient();

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

export async function createConnectDashboardLoginLink(
  organizationId: string
) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      stripeConnectAccountId: true,
      stripeConnectDetailsSubmitted: true,
    },
  });

  if (!organization) {
    throw Object.assign(
      new Error(`Organization not found: ${organizationId}`),
      {
        statusCode: 404,
        code: "ORGANIZATION_NOT_FOUND",
      }
    );
  }

  const accountId = String(
    organization.stripeConnectAccountId ?? ""
  ).trim();

  if (!accountId) {
    throw Object.assign(
      new Error("Stripe Connect payout account is not connected."),
      {
        statusCode: 409,
        code: "STRIPE_CONNECT_NOT_CONNECTED",
      }
    );
  }

  if (!organization.stripeConnectDetailsSubmitted) {
    throw Object.assign(
      new Error(
        "Stripe Connect onboarding must be completed before opening the Express Dashboard."
      ),
      {
        statusCode: 409,
        code: "STRIPE_CONNECT_ONBOARDING_INCOMPLETE",
      }
    );
  }

  const loginLink = await getStripeClient().accounts.createLoginLink(
    accountId
  );

  return {
    url: loginLink.url,
    accountId,
  };
}
