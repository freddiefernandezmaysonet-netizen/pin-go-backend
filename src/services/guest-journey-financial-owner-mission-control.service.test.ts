import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
  PaymentState,
} from "@prisma/client";

import { syncGuestJourneyFinancialOwnerMissionControl } from "./guest-journey-financial-owner-mission-control.service";

const now = new Date("2026-08-24T12:00:00.000Z");

function fixture(input: {
  status?: GuestJourneyCoordinationIntentStatus;
  intentType?: string;
  existing?: any;
} = {}) {
  const intent: any = {
    id: "intent-1",
    targetEngine: "FINANCIAL",
    intentType: input.intentType ?? "REQUEST_PAYMENT_EVALUATION",
    status: input.status ?? GuestJourneyCoordinationIntentStatus.EXHAUSTED,
    claimCount: 3,
    lastError: "FINANCIAL_DIRECT_BOOKING_STRIPE_EVIDENCE_INCOMPLETE",
    updatedAt: now,
    succeededAt: null,
    exhaustedAt: now,
    supersededAt: null,
    reservationId: "reservation-1",
    reservation: {
      reservationNumber: "PG-2026-000200",
      guestName: "Test Guest",
      paymentState: PaymentState.PAID,
      hostPayoutStatus: "ROUTED_TO_CONNECT",
      propertyId: "property-1",
      property: { organizationId: "org-1" },
    },
  };
  const writes: any[] = [];
  const prisma: any = {
    guestJourneyCoordinationIntent: {
      findUnique: async () => intent,
    },
    operationalIssue: {
      findUnique: async () => input.existing ?? null,
    },
  };
  const upsert = async (_prisma: any, payload: any) => {
    writes.push(payload);
    return payload;
  };
  return { prisma, intent, writes, upsert };
}

test("E9 Mission Control creates developer-only payment escalation", async () => {
  const state = fixture();
  const result = await syncGuestJourneyFinancialOwnerMissionControl(
    state.prisma,
    "intent-1",
    { organizationId: "org-1", propertyId: "property-1" },
    { upsert: state.upsert as any }
  );
  assert.equal(result.action, "CREATED");
  assert.equal(result.externalSideEffects, 0);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].visibility, "DEVELOPER");
  assert.equal(state.writes[0].workflowState, "ACTION_REQUIRED");
  assert.equal(state.writes[0].actionTarget, "PAYMENT");
});

test("E9 Mission Control does not duplicate a current payment escalation", async () => {
  const state = fixture({
    existing: {
      workflowState: "ACTION_REQUIRED",
      lastSignalAt: now,
      firstDetectedAt: now,
    },
  });
  const result = await syncGuestJourneyFinancialOwnerMissionControl(
    state.prisma,
    "intent-1",
    { organizationId: "org-1", propertyId: "property-1" },
    { upsert: state.upsert as any }
  );
  assert.equal(result.action, "UNCHANGED");
  assert.equal(state.writes.length, 0);
});

test("E9 Mission Control resolves an existing escalation after recovery", async () => {
  const firstDetectedAt = new Date(now.getTime() - 60_000);
  const state = fixture({
    status: GuestJourneyCoordinationIntentStatus.SUCCEEDED,
    existing: {
      workflowState: "ACTION_REQUIRED",
      lastSignalAt: firstDetectedAt,
      firstDetectedAt,
    },
  });
  state.intent.succeededAt = now;
  const result = await syncGuestJourneyFinancialOwnerMissionControl(
    state.prisma,
    "intent-1",
    { organizationId: "org-1", propertyId: "property-1" },
    { upsert: state.upsert as any }
  );
  assert.equal(result.action, "RESOLVED");
  assert.equal(state.writes[0].workflowState, "RESOLVED");
  assert.equal(state.writes[0].resolutionCode, "FINANCIAL_OWNER_RECOVERY_CLEARED");
});

test("E9 Mission Control fails closed on scope or handler drift", async () => {
  const state = fixture();
  await assert.rejects(
    syncGuestJourneyFinancialOwnerMissionControl(
      state.prisma,
      "intent-1",
      { organizationId: "other", propertyId: "property-1" },
      { upsert: state.upsert as any }
    ),
    /SCOPE_MISMATCH/
  );
  state.intent.intentType = "REQUEST_ACCESS_EVALUATION";
  await assert.rejects(
    syncGuestJourneyFinancialOwnerMissionControl(
      state.prisma,
      "intent-1",
      { organizationId: "org-1", propertyId: "property-1" },
      { upsert: state.upsert as any }
    ),
    /INTENT_UNSUPPORTED/
  );
  assert.equal(state.writes.length, 0);
});
