import test from "node:test";
import assert from "node:assert/strict";

import { syncStripeDirectChargeDispute } from "./stripe-direct-charge-dispute.service";

function event(type: "charge.dispute.created" | "charge.dispute.updated" | "charge.dispute.closed", created = 1_700_000_000) {
  return {
    id: `evt_${type}`,
    type,
    created,
    account: "acct_host",
    data: {
      object: {
        id: "dp_123",
        object: "dispute",
        charge: "ch_123",
        payment_intent: "pi_123",
        status: type === "charge.dispute.closed" ? "won" : "needs_response",
        reason: "fraudulent",
        amount: 2000,
        currency: "usd",
        evidence_details: { due_by: 1_700_086_400 },
      },
    },
  } as any;
}

function fixture(existing: any = null) {
  const writes: any[] = [];
  return {
    writes,
    prisma: {
      reservation: {
        findFirst: async () => ({
          id: "res_123",
          reservationNumber: "PG-2026-000050",
          guestName: "Guest",
          propertyId: "prop_123",
          stripeConnectedAccountId: "acct_host",
          property: { organizationId: "org_123" },
        }),
      },
      operationalIssue: {
        findUnique: async () => existing,
      },
    } as any,
    dependencies: {
      upsert: async (_db: any, input: any) => {
        writes.push(input);
        return input;
      },
    } as any,
  };
}

test("created dispute escalates a host-visible PAYMENT ACTION_REQUIRED issue", async () => {
  const f = fixture();
  const result = await syncStripeDirectChargeDispute(f.prisma, event("charge.dispute.created"), f.dependencies);
  assert.equal(result.action, "CREATED");
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].workflowState, "ACTION_REQUIRED");
  assert.equal(f.writes[0].visibility, "HOST");
  assert.equal(f.writes[0].actionTarget, "PAYMENT");
  assert.equal(f.writes[0].operationalKey, "STRIPE_DIRECT_CHARGE_DISPUTE:dp_123");
});

test("replayed dispute event is idempotent", async () => {
  const occurredAt = new Date(1_700_000_000 * 1000);
  const f = fixture({
    workflowState: "ACTION_REQUIRED",
    firstDetectedAt: occurredAt,
    lastSignalAt: occurredAt,
  });
  const result = await syncStripeDirectChargeDispute(f.prisma, event("charge.dispute.created"), f.dependencies);
  assert.equal(result.action, "UNCHANGED");
  assert.equal(f.writes.length, 0);
});

test("closed dispute resolves the existing operational issue without financial side effects", async () => {
  const firstDetectedAt = new Date(1_699_000_000 * 1000);
  const f = fixture({
    workflowState: "ACTION_REQUIRED",
    firstDetectedAt,
    lastSignalAt: firstDetectedAt,
  });
  const result = await syncStripeDirectChargeDispute(f.prisma, event("charge.dispute.closed"), f.dependencies);
  assert.equal(result.action, "RESOLVED");
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].workflowState, "RESOLVED");
  assert.equal(f.writes[0].actionRequired, false);
  assert.equal(f.writes[0].resolvedAt.getTime(), 1_700_000_000 * 1000);
});

test("connected-account scope mismatch fails closed", async () => {
  const f = fixture();
  const mismatched = event("charge.dispute.created") as any;
  mismatched.account = "acct_other";
  await assert.rejects(
    () => syncStripeDirectChargeDispute(f.prisma, mismatched, f.dependencies),
    /STRIPE_DIRECT_CHARGE_DISPUTE_ACCOUNT_SCOPE_MISMATCH/
  );
  assert.equal(f.writes.length, 0);
});
