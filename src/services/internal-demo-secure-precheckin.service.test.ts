import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { completeInternalDemoSecurePrecheckin } from "./internal-demo-secure-precheckin.service.js";

const now = new Date("2026-08-17T12:00:00.000Z");

function buildHarness(input?: {
  role?: string;
  externalId?: string | null;
  externalProvider?: string | null;
  requiresIdentityVerification?: boolean;
  readiness?: {
    ready: boolean;
    blockers: string[];
  };
}) {
  const calls = {
    findUnique: 0,
    transaction: 0,
    updates: [] as Array<Record<string, any>>,
    ensureJourney: 0,
    ensureSnapshot: 0,
    completeJourney: 0,
    evaluateReadiness: 0,
    audits: [] as Array<Record<string, any>>,
  };
  const reservation = {
    id: "reservation-demo-1",
    externalId:
      input?.externalId === undefined
        ? "DEMO-123"
        : input.externalId,
    externalProvider:
      input?.externalProvider === undefined
        ? "LODGIFY"
        : input.externalProvider,
    guestName: "Pin&Go Demo Guest",
    propertyId: "property-1",
    property: {
      organizationId: "organization-1",
    },
  };
  const tx = {
    reservation: {
      update: async (query: Record<string, any>) => {
        calls.updates.push(query);
        return reservation;
      },
    },
  };
  const prisma = {
    reservation: {
      findUnique: async () => {
        calls.findUnique += 1;
        return reservation;
      },
    },
    $transaction: async (callback: (value: any) => unknown) => {
      calls.transaction += 1;
      return callback(tx);
    },
  } as unknown as PrismaClient;
  const readiness = input?.readiness ?? {
    ready: true,
    blockers: [],
  };
  const dependencies = {
    ensureGuestJourney: async () => {
      calls.ensureJourney += 1;
      return {
        journeyId: "journey-1",
        currentState: "VERIFICATION_PENDING",
        created: true,
        transitioned: true,
      };
    },
    ensureAgreementSnapshot: async () => {
      calls.ensureSnapshot += 1;
      return {
        ok: true,
        alreadyCaptured: false,
        snapshot: {
          agreementId: "agreement-1",
          propertyId: "property-1",
          version: "1",
          title: "Demo agreement",
          capturedAt: now.toISOString(),
          requiresIdentityVerification:
            input?.requiresIdentityVerification !== false,
        },
      };
    },
    completeGuestJourney: async () => {
      calls.completeJourney += 1;
      return {
        journeyId: "journey-1",
        currentState: "VERIFICATION_COMPLETED",
        transitioned: true,
      };
    },
    evaluateReadiness: async () => {
      calls.evaluateReadiness += 1;
      return {
        ...readiness,
        reservationId: reservation.id,
        reservationNumber: "PG-2026-DEMO",
        propertyId: reservation.propertyId,
        guestAccessMode: "PASSCODE_ONLY",
        releaseStatus: readiness.ready
          ? "ELIGIBLE"
          : "BLOCKED",
        checkIn: now,
        checkOut: new Date(
          now.getTime() + 60 * 60 * 1000
        ),
      };
    },
    persistAudit: async (_tx: unknown, entry: Record<string, any>) => {
      calls.audits.push(entry);
      return entry;
    },
  };

  return {
    prisma,
    dependencies: dependencies as any,
    calls,
    actor: {
      userId: "platform-user-1",
      organizationId: "organization-1",
      email: "platform@example.com",
      role: input?.role ?? "PLATFORM_ADMIN",
    },
  };
}

test("controlled demo records simulated verification evidence and remains access-engine eligible", async () => {
  const harness = buildHarness();

  const result =
    await completeInternalDemoSecurePrecheckin(
      harness.prisma,
      {
        reservationId: "reservation-demo-1",
        actor: harness.actor,
        now,
      },
      harness.dependencies
    );

  assert.equal(result.simulated, true);
  assert.equal(result.source, "INTERNAL_DEMO_CENTER");
  assert.equal(result.readiness.ready, true);
  assert.equal(harness.calls.transaction, 1);
  assert.equal(harness.calls.ensureJourney, 1);
  assert.equal(harness.calls.ensureSnapshot, 1);
  assert.equal(harness.calls.completeJourney, 1);
  assert.equal(harness.calls.evaluateReadiness, 1);
  assert.equal(harness.calls.audits.length, 1);

  const update = harness.calls.updates[0];
  assert.equal(update.where.id, "reservation-demo-1");
  assert.equal(update.data.verificationStatus, "COMPLETED");
  assert.equal(
    update.data.identityVerificationProvider,
    "INTERNAL_DEMO_CENTER"
  );
  assert.equal(
    update.data.guestAgreementAcceptance.source,
    "INTERNAL_DEMO_CENTER"
  );
  assert.equal(
    update.data.guestAgreementAcceptance.simulated,
    true
  );
  assert.equal(
    update.data.securePreCheckinDisclosureAcceptance.demoOnly,
    true
  );

  const audit = harness.calls.audits[0];
  assert.equal(audit.engine, "Access");
  assert.equal(
    audit.decisionId,
    "internal-demo-secure-precheckin:reservation-demo-1"
  );
  assert.equal(audit.metadata.actorUserId, "platform-user-1");
  assert.equal(audit.metadata.demoOnly, true);
});

test("controlled demo respects properties where identity verification is not required", async () => {
  const harness = buildHarness({
    requiresIdentityVerification: false,
  });

  await completeInternalDemoSecurePrecheckin(
    harness.prisma,
    {
      reservationId: "reservation-demo-1",
      actor: harness.actor,
      now,
    },
    harness.dependencies
  );

  const update = harness.calls.updates[0];
  assert.equal(update.data.verificationStatus, "NOT_REQUIRED");
  assert.equal(update.data.verifiedAt, null);
  assert.equal(update.data.identityVerificationProvider, null);
  assert.equal(
    update.data.guestAgreementAcceptance.identityConsentAccepted,
    false
  );
});

test("controlled demo rejects non-platform actors before querying reservation data", async () => {
  const harness = buildHarness({ role: "ORG_ADMIN" });

  await assert.rejects(
    completeInternalDemoSecurePrecheckin(
      harness.prisma,
      {
        reservationId: "reservation-demo-1",
        actor: harness.actor,
        now,
      },
      harness.dependencies
    ),
    /INTERNAL_DEMO_PLATFORM_ADMIN_REQUIRED/
  );

  assert.equal(harness.calls.findUnique, 0);
  assert.equal(harness.calls.transaction, 0);
});

test("controlled demo rejects ordinary reservations before writing evidence", async () => {
  const harness = buildHarness({
    externalId: "REAL-123",
  });

  await assert.rejects(
    completeInternalDemoSecurePrecheckin(
      harness.prisma,
      {
        reservationId: "reservation-demo-1",
        actor: harness.actor,
        now,
      },
      harness.dependencies
    ),
    /INTERNAL_DEMO_RESERVATION_REQUIRED/
  );

  assert.equal(harness.calls.transaction, 0);
  assert.equal(harness.calls.updates.length, 0);
});

test("controlled demo rejects reservations from another organization", async () => {
  const harness = buildHarness();

  await assert.rejects(
    completeInternalDemoSecurePrecheckin(
      harness.prisma,
      {
        reservationId: "reservation-demo-1",
        actor: {
          ...harness.actor,
          organizationId: "organization-2",
        },
        now,
      },
      harness.dependencies
    ),
    /INTERNAL_DEMO_ORGANIZATION_MISMATCH/
  );

  assert.equal(harness.calls.transaction, 0);
  assert.equal(harness.calls.updates.length, 0);
});

test("controlled demo refuses to audit or release access while readiness remains blocked", async () => {
  const harness = buildHarness({
    readiness: {
      ready: false,
      blockers: ["GUEST_AGREEMENT_NOT_SIGNED"],
    },
  });

  await assert.rejects(
    completeInternalDemoSecurePrecheckin(
      harness.prisma,
      {
        reservationId: "reservation-demo-1",
        actor: harness.actor,
        now,
      },
      harness.dependencies
    ),
    /INTERNAL_DEMO_ACCESS_NOT_READY:GUEST_AGREEMENT_NOT_SIGNED/
  );

  assert.equal(harness.calls.audits.length, 0);
});

test("Demo Center invokes secure pre-check-in only for a processed demo reservation", async () => {
  const source = await readFile(
    new URL("../routes/admin.demo.routes.ts", import.meta.url),
    "utf8"
  );
  const serviceSource = await readFile(
    new URL(
      "./internal-demo-secure-precheckin.service.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    source,
    /reservation\s*&&\s*processedEvent\?\.status\s*===\s*"PROCESSED"/
  );
  assert.match(
    source,
    /completeInternalDemoSecurePrecheckin\(\s*prisma,\s*\{\s*reservationId:\s*reservation\.id/
  );
  assert.match(
    source,
    /userId:\s*user\.id[\s\S]*organizationId:\s*user\.orgId[\s\S]*role:\s*user\.role/
  );
  assert.match(
    source,
    /DEMO_SECURE_PRECHECKIN_FAILED:/
  );
  assert.ok(
    source.indexOf("processWebhookEventById(event.id)") <
      source.indexOf(
        "await completeInternalDemoSecurePrecheckin"
      )
  );
  assert.doesNotMatch(
    serviceSource,
    /ttlock|activateGrant|accessGrant\.(?:create|update)/i
  );
});
