import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  StripeConnectIsolationV2Error,
  assertStripeConnectTenantOwnership,
  buildStripeConnectIsolationV2AccountCreateParams,
  buildStripeConnectIsolationV2AccountSessionParams,
  isStripeConnectIsolationV2Enabled,
  isStripeConnectV2AccountCreationEnabled,
} from "./stripe-connect-isolation-v2.service.js";

type AccountSessionComponentsCompat =
  Stripe.AccountSessionCreateParams["components"] & {
    account_management?: { enabled?: boolean };
    notification_banner?: { enabled?: boolean };
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

test("Isolation V2 is default-off", () => {
  assert.equal(isStripeConnectIsolationV2Enabled({}), false);
  assert.equal(
    isStripeConnectIsolationV2Enabled({
      STRIPE_CONNECT_ISOLATION_V2_ENABLED: "true",
    }),
    true
  );
});

test("V2 account creation has a separate default-off fence", () => {
  assert.equal(isStripeConnectV2AccountCreationEnabled({}), false);
  assert.equal(
    isStripeConnectV2AccountCreationEnabled({
      STRIPE_CONNECT_V2_ACCOUNT_CREATION_ENABLED: "true",
    }),
    true
  );
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

test("V2 Account Session includes no-dashboard required surfaces and keeps money-moving actions disabled", () => {
  const params = buildStripeConnectIsolationV2AccountSessionParams(
    "acct_fernandez"
  );
  const components = params.components as AccountSessionComponentsCompat;

  assert.equal(params.account, "acct_fernandez");
  assert.equal(components.account_onboarding?.enabled, true);
  assert.equal(components.account_management?.enabled, true);
  assert.equal(components.notification_banner?.enabled, true);
  assert.equal(components.documents?.enabled, true);
  assert.equal(components.payments?.enabled, true);
  assert.equal(
    components.payments?.features?.refund_management,
    false
  );
  assert.equal(
    components.payments?.features?.dispute_management,
    false
  );
  assert.equal(components.payouts?.enabled, true);
  assert.equal(
    components.payouts?.features?.standard_payouts,
    false
  );
  assert.equal(
    components.payouts?.features?.instant_payouts,
    false
  );
});
