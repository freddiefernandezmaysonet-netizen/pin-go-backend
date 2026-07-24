import assert from "node:assert/strict";
import test from "node:test";

import type Stripe from "stripe";

import {
  mapStripeAccountStatus,
} from "../stripe-connect.service";

function createAccount(
  overrides: Partial<Stripe.Account> = {}
): Stripe.Account {
  return {
    id: "acct_test",
    object: "account",
    business_profile: null,
    business_type: null,
    capabilities: {},
    charges_enabled: false,
    company: {} as Stripe.Account.Company,
    controller: {} as Stripe.Account.Controller,
    country: "US",
    created: 0,
    default_currency: "usd",
    details_submitted: false,
    email: null,
    external_accounts: {
      object: "list",
      data: [],
      has_more: false,
      url: "/v1/accounts/acct_test/external_accounts",
    },
    future_requirements: null,
    individual: null,
    metadata: {},
    payouts_enabled: false,
    requirements: null,
    settings: {} as Stripe.Account.Settings,
    tos_acceptance: null,
    type: "express",
    ...overrides,
  } as Stripe.Account;
}

test("maps disabled Stripe requirements to restricted", () => {
  const status = mapStripeAccountStatus(
    createAccount({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: {
        alternatives: [],
        current_deadline: null,
        currently_due: [],
        disabled_reason:
          "requirements.past_due",
        errors: [],
        eventually_due: [],
        past_due: [],
        pending_verification: [],
      },
    })
  );

  assert.equal(status, "RESTRICTED");
});

test("maps enabled charge and payout capabilities to ready", () => {
  const status = mapStripeAccountStatus(
    createAccount({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    })
  );

  assert.equal(status, "READY");
});

test("maps incomplete account details to onboarding required", () => {
  const status = mapStripeAccountStatus(
    createAccount({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
    })
  );

  assert.equal(
    status,
    "ONBOARDING_REQUIRED"
  );
});

test("maps submitted details awaiting capabilities to pending verification", () => {
  const status = mapStripeAccountStatus(
    createAccount({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
    })
  );

  assert.equal(
    status,
    "PENDING_VERIFICATION"
  );
});
