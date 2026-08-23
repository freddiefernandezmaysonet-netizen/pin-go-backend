import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
  type PrismaClient,
} from "@prisma/client";

import { syncGuestJourneyCommunicationMissionControl } from "./guest-journey-communications-mission-control.service";

const now = new Date("2026-08-23T06:30:00.000Z");

function fakePrisma(input: {
  status: GuestJourneyCoordinationIntentStatus;
  existing?: any;
}) {
  const upserts: any[] = [];
  const intent = {
    id: "intent-1",
    targetEngine: "COMMUNICATIONS",
    intentType: "REQUEST_COMMUNICATION_RETRY",
    status: input.status,
    claimCount: 3,
    lastError: "PROVIDER_DOWN",
    createdAt: new Date(now.getTime() - 60_000),
    updatedAt: now,
    succeededAt: input.status === GuestJourneyCoordinationIntentStatus.SUCCEEDED ? now : null,
    exhaustedAt: input.status === GuestJourneyCoordinationIntentStatus.EXHAUSTED ? now : null,
    supersededAt: null,
    reservationId: "reservation-1",
    reservation: {
      reservationNumber: "PG-2026-000071",
      guestName: "Guest",
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
  return {
    prisma,
    upserts,
    dependencies: {
      upsert: async (_prisma: any, issue: any) => {
        upserts.push(issue);
        return issue;
      },
    },
  };
}

const scope = { organizationId: "org-1", propertyId: "property-1" };

test("exhausted communications create developer-only ACTION_REQUIRED evidence", async () => {
  const fixture = fakePrisma({ status: GuestJourneyCoordinationIntentStatus.EXHAUSTED });
  const result = await syncGuestJourneyCommunicationMissionControl(
    fixture.prisma,
    "intent-1",
    scope,
    fixture.dependencies as any
  );
  assert.equal(result.action, "CREATED");
  assert.equal(fixture.upserts.length, 1);
  assert.equal(fixture.upserts[0].workflowState, "ACTION_REQUIRED");
  assert.equal(fixture.upserts[0].visibility, "DEVELOPER");
  assert.equal(fixture.upserts[0].actionRequired, true);
  assert.equal(fixture.upserts[0].actionTarget, "MESSAGING");
});

test("a current exhausted projection is idempotently unchanged", async () => {
  const fixture = fakePrisma({
    status: GuestJourneyCoordinationIntentStatus.EXHAUSTED,
    existing: {
      workflowState: "ACTION_REQUIRED",
      lastSignalAt: now,
      firstDetectedAt: now,
    },
  });
  const result = await syncGuestJourneyCommunicationMissionControl(
    fixture.prisma,
    "intent-1",
    scope,
    fixture.dependencies as any
  );
  assert.equal(result.action, "UNCHANGED");
  assert.equal(fixture.upserts.length, 0);
});

test("successful recovery automatically resolves an existing escalation", async () => {
  const fixture = fakePrisma({
    status: GuestJourneyCoordinationIntentStatus.SUCCEEDED,
    existing: {
      workflowState: "ACTION_REQUIRED",
      lastSignalAt: new Date(now.getTime() - 1_000),
      firstDetectedAt: new Date(now.getTime() - 60_000),
    },
  });
  const result = await syncGuestJourneyCommunicationMissionControl(
    fixture.prisma,
    "intent-1",
    scope,
    fixture.dependencies as any
  );
  assert.equal(result.action, "RESOLVED");
  assert.equal(fixture.upserts[0].workflowState, "RESOLVED");
  assert.equal(fixture.upserts[0].actionRequired, false);
  assert.equal(fixture.upserts[0].resolvedBy, "PIN_GO");
});

test("scope drift fails closed before Mission Control writes", async () => {
  const fixture = fakePrisma({ status: GuestJourneyCoordinationIntentStatus.EXHAUSTED });
  await assert.rejects(
    syncGuestJourneyCommunicationMissionControl(
      fixture.prisma,
      "intent-1",
      { organizationId: "other-org", propertyId: "property-1" },
      fixture.dependencies as any
    ),
    /MISSION_CONTROL_SCOPE_MISMATCH/
  );
  assert.equal(fixture.upserts.length, 0);
});
