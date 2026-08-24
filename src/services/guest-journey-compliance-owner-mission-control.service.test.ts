import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
  type PrismaClient,
} from "@prisma/client";

import { syncGuestJourneyComplianceOwnerMissionControl } from "./guest-journey-compliance-owner-mission-control.service";

function state(input: Partial<any> = {}) {
  const writes: any[] = [];
  const intent: any = {
    id: "intent-1",
    targetEngine: "COMPLIANCE",
    intentType: input.intentType ?? "REQUEST_GUEST_VERIFICATION",
    status: input.status ?? GuestJourneyCoordinationIntentStatus.EXHAUSTED,
    claimCount: 3,
    lastError: "GUEST_VERIFICATION_EVIDENCE_PENDING",
    updatedAt: new Date("2026-08-24T13:00:00.000Z"),
    succeededAt: null,
    exhaustedAt: new Date("2026-08-24T13:00:00.000Z"),
    supersededAt: null,
    reservationId: "reservation-1",
    reservation: {
      reservationNumber: "PG-2026-000001",
      guestName: "Guest",
      verificationStatus: "PENDING",
      propertyId: "property-1",
      property: { organizationId: "org-1" },
    },
  };
  const prisma = {
    guestJourneyCoordinationIntent: {
      findUnique: async () => intent,
    },
    operationalIssue: {
      findUnique: async () => input.existing ?? null,
    },
  } as unknown as PrismaClient;
  return { prisma, intent, writes };
}

test("E10 Compliance Mission Control creates ACTION_REQUIRED on exhausted intent", async () => {
  const fixture = state();
  const result = await syncGuestJourneyComplianceOwnerMissionControl(
    fixture.prisma,
    "intent-1",
    { organizationId: "org-1", propertyId: "property-1" },
    {
      upsert: async (_prisma, payload) => {
        fixture.writes.push(payload);
        return payload as never;
      },
    }
  );

  assert.equal(result.action, "CREATED");
  assert.equal(result.operationalIssueWrites, 1);
  assert.equal(result.externalSideEffects, 0);
  assert.equal(fixture.writes[0].issueCode, "GUEST_JOURNEY_COMPLIANCE_OWNER_EXHAUSTED");
  assert.equal(fixture.writes[0].actionTarget, "GUEST");
  assert.equal(fixture.writes[0].workflowState, "ACTION_REQUIRED");
});

test("E10 Compliance Mission Control resolves existing issue after recovery", async () => {
  const fixture = state({
    status: GuestJourneyCoordinationIntentStatus.SUCCEEDED,
    existing: {
      workflowState: "ACTION_REQUIRED",
      firstDetectedAt: new Date("2026-08-24T12:00:00.000Z"),
      lastSignalAt: new Date("2026-08-24T12:00:00.000Z"),
    },
  });
  fixture.intent.succeededAt = new Date("2026-08-24T13:05:00.000Z");
  fixture.intent.exhaustedAt = null;

  const result = await syncGuestJourneyComplianceOwnerMissionControl(
    fixture.prisma,
    "intent-1",
    { organizationId: "org-1", propertyId: "property-1" },
    {
      upsert: async (_prisma, payload) => {
        fixture.writes.push(payload);
        return payload as never;
      },
    }
  );

  assert.equal(result.action, "RESOLVED");
  assert.equal(fixture.writes[0].workflowState, "RESOLVED");
  assert.equal(fixture.writes[0].resolutionCode, "COMPLIANCE_OWNER_RECOVERY_CLEARED");
});

test("E10 Compliance Mission Control rejects scope mismatch", async () => {
  const fixture = state();
  await assert.rejects(
    syncGuestJourneyComplianceOwnerMissionControl(
      fixture.prisma,
      "intent-1",
      { organizationId: "org-x", propertyId: "property-1" }
    ),
    /COMPLIANCE_OWNER_MISSION_CONTROL_SCOPE_MISMATCH/
  );
});
