import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  STRIPE_CONNECT_V2_ACCOUNT_SESSION_API_VERSION,
  StripeConnectIsolationV2Error,
  assertStripeConnectTenantOwnership,
  buildStripeConnectIsolationV2AccountCreateParams,
  buildStripeConnectIsolationV2AccountSessionParams,
  buildStripeConnectIsolationV2AccountSessionRequestOptions,
  getStripeConnectV2Eligibility,
  isStripeConnectV2AccountCreationEnabled,
} from "./stripe-connect-isolation-v2.service.js";

type AccountSessionComponentsCompat =
  Stripe.AccountSessionCreateParams["components"] & {
    account_onboarding?: {
      enabled?: boolean;
      features?: {
        external_account_collection?: boolean;
        disable_stripe_user_authentication?: boolean;
      };
    };
    account_management?: {
      enabled?: boolean;
      features?: { external_account_collection?: boolean };
    };
    notification_banner?: {
      enabled?: boolean;
      features?: { external_account_collection?: boolean };
    };
  };

function stripeAccount(input: {
  id: string;
  organizationId?: string;
}): Stripe.Account {
  return {
    id: input.id,
    object: "account",
    metadata: input.organizationId
      ? { organizationId: input.organizationId }
      : {},
  } as unknown as Stripe.Account;
}

test("global experience does not depend on historical canary or isolation flags", () => {
  for (const org of ["org_serena", "org_existing", "org_new"]) {
    assert.deepEqual(getStripeConnectV2Eligibility(org, {}), { eligible: true, accountCreationAllowed: false });
    assert.deepEqual(getStripeConnectV2Eligibility(org, {
      STRIPE_CONNECT_ISOLATION_V2_ENABLED: "false",
      STRIPE_CONNECT_V2_CANARY_ORGANIZATION_IDS: "another_org",
      STRIPE_CONNECT_V2_ACCOUNT_CREATION_ENABLED: "true",
    }), { eligible: true, accountCreationAllowed: true });
  }
  assert.deepEqual(getStripeConnectV2Eligibility("", { STRIPE_CONNECT_V2_ACCOUNT_CREATION_ENABLED: "true" }),
    { eligible: false, accountCreationAllowed: false });
});

test("account creation keeps the existing independent kill switch", () => {
  assert.equal(isStripeConnectV2AccountCreationEnabled({}), false);
  assert.equal(isStripeConnectV2AccountCreationEnabled({ STRIPE_CONNECT_V2_ACCOUNT_CREATION_ENABLED: "true" }), true);
});

test("tenant ownership accepts only the persisted account bound to the same organization", () => {
  const account = stripeAccount({
    id: "acct_fernandez",
    organizationId: "org_fernandez",
  });

  const result = assertStripeConnectTenantOwnership({
    organizationId: "org_fernandez",
    persistedAccountId: "acct_fernandez",
    account,
  });

  assert.equal(result.id, "acct_fernandez");
});

test("tenant ownership fails closed when Stripe metadata belongs to another organization", () => {
  const account = stripeAccount({
    id: "acct_remanso",
    organizationId: "org_remanso",
  });

  assert.throws(
    () =>
      assertStripeConnectTenantOwnership({
        organizationId: "org_fernandez",
        persistedAccountId: "acct_remanso",
        account,
      }),
    (error: unknown) =>
      error instanceof StripeConnectIsolationV2Error &&
      error.code === "STRIPE_CONNECT_TENANT_MISMATCH"
  );
});

test("tenant ownership fails closed when persisted account id and Stripe account differ", () => {
  const account = stripeAccount({
    id: "acct_remanso",
    organizationId: "org_fernandez",
  });

  assert.throws(
    () =>
      assertStripeConnectTenantOwnership({
        organizationId: "org_fernandez",
        persistedAccountId: "acct_fernandez",
        account,
      }),
    (error: unknown) =>
      error instanceof StripeConnectIsolationV2Error &&
      error.code === "STRIPE_CONNECT_ACCOUNT_ID_MISMATCH"
  );
});

test("new V2 account policy makes the connected account pay Stripe fees and keeps Stripe-hosted dashboard disabled", () => {
  const params = buildStripeConnectIsolationV2AccountCreateParams({
    organizationId: "org_fernandez",
    organizationName: "Fernandez Property Management LLC",
    country: "PR",
  });
  const metadata = params.metadata as Stripe.MetadataParam;

  assert.equal(params.email, undefined);
  assert.equal(params.type, undefined);
  assert.equal(params.country, "US");
  assert.equal(params.controller?.fees?.payer, "account");
  assert.equal(params.controller?.losses?.payments, "stripe");
  assert.equal(params.controller?.requirement_collection, "stripe");
  assert.equal(params.controller?.stripe_dashboard?.type, "none");
  assert.equal(metadata.organizationId, "org_fernandez");
});

test("pre-onboarding V2 Account Session enables only account onboarding", () => {
  const params = buildStripeConnectIsolationV2AccountSessionParams({
    accountId: "acct_fernandez",
    detailsSubmitted: false,
  });
  const components = params.components as AccountSessionComponentsCompat;
  const requestOptions =
    buildStripeConnectIsolationV2AccountSessionRequestOptions() as {
      apiVersion?: string;
    };

  assert.equal(params.account, "acct_fernandez");
  assert.equal(components.account_onboarding?.enabled, true);
  assert.equal(
    components.account_onboarding?.features?.external_account_collection,
    true
  );
  assert.equal(
    components.account_onboarding?.features?.disable_stripe_user_authentication,
    false
  );
  assert.equal(components.notification_banner, undefined);
  assert.equal(components.account_management, undefined);
  assert.equal(components.documents, undefined);
  assert.equal(components.payments, undefined);
  assert.equal(components.payouts, undefined);
  assert.equal(
    STRIPE_CONNECT_V2_ACCOUNT_SESSION_API_VERSION,
    "2026-03-25.dahlia"
  );
  assert.equal(
    requestOptions.apiVersion,
    STRIPE_CONNECT_V2_ACCOUNT_SESSION_API_VERSION
  );
});

test("post-onboarding V2 Account Session enables remediation, account, payment and payout surfaces without onboarding", () => {
  const params = buildStripeConnectIsolationV2AccountSessionParams({
    accountId: "acct_fernandez",
    detailsSubmitted: true,
  });
  const components = params.components as AccountSessionComponentsCompat;

  assert.equal(params.account, "acct_fernandez");
  assert.equal(components.notification_banner?.enabled, true);
  assert.equal(components.account_onboarding, undefined);
  assert.equal(components.account_management?.enabled, true);
  assert.equal(
    components.account_management?.features?.external_account_collection,
    true
  );
  assert.equal(components.documents?.enabled, true);
  assert.equal(components.payments?.enabled, true);
  assert.equal(components.payments?.features?.refund_management, false);
  assert.equal(components.payments?.features?.dispute_management, false);
  assert.equal(components.payouts?.enabled, true);
  assert.equal(components.payouts?.features?.standard_payouts, false);
  assert.equal(components.payouts?.features?.instant_payouts, false);
});
