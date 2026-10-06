import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  completeInternalDemoSecurePrecheckin,
  INTERNAL_DEMO_PROPERTY_ID,
} from "./internal-demo-secure-precheckin.service.js";

const now = new Date("2026-08-17T12:00:00.000Z");

function buildHarness(input?: {
  role?: string;
  source?: string | null;
  externalId?: string | null;
  externalProvider?: string | null;
  externalRaw?: unknown;
  propertyId?: string;
  propertyStatus?: string;
  requiresIdentityVerification?: boolean;
  readiness?: {
    ready: boolean;
    blockers: string[];
  };
}) {
  const calls = {
    findUnique: 0,
    transaction: 0,
    queries: [] as Array<Record<string, any>>,
    updates: [] as Array<Record<string, any>>,
    ensureJourney: 0,
    ensureSnapshot: 0,
    completeJourney: 0,
    evaluateReadiness: 0,
    audits: [] as Array<Record<string, any>>,
  };
  const reservation = {
    id: "reservation-demo-1",
    source: input?.source === undefined ? "INTERNAL_DEMO_DIRECT_BOOKING" : input.source,
    externalId:
      input?.externalId === undefined
        ? "DEMO-123"
        : input.externalId,
    externalProvider:
      input?.externalProvider === undefined
        ? "PIN_GO_INTERNAL_DEMO"
        : input.externalProvider,
    guestName: "Pin&Go Demo Guest",
    propertyId: input?.propertyId ?? INTERNAL_DEMO_PROPERTY_ID,
    externalRaw: input?.externalRaw === undefined
      ? { demo: true, paymentSimulated: true, created_by: "platform@example.com" }
      : input.externalRaw,
    property: {
      organizationId: "organization-1",
      status: input?.propertyStatus ?? "ACTIVE",
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
      findUnique: async (query: Record<string, any>) => {
        calls.findUnique += 1;
        calls.queries.push(query);
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
          propertyId: reservation.propertyId,
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
        guestAccessMode: "PASSCODE_PLUS_NFC",
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
        delivery: {
          preferredLanguage: "es",
          smsConsent: true,
        },
        now,
      },
      harness.dependencies
    );

  assert.equal(result.simulated, true);
  assert.equal(result.source, "INTERNAL_DEMO_CENTER");
  assert.equal(result.readiness.ready, true);
  assert.equal(
    result.readiness.guestAccessMode,
    "PASSCODE_PLUS_NFC"
  );
  assert.equal(harness.calls.transaction, 1);
  assert.equal(harness.calls.ensureJourney, 1);
  assert.equal(harness.calls.ensureSnapshot, 1);
  assert.equal(harness.calls.completeJourney, 1);
  assert.equal(harness.calls.evaluateReadiness, 1);
  assert.equal(harness.calls.audits.length, 1);
  assert.equal(harness.calls.queries[0].select.source, true);
  assert.equal(harness.calls.queries[0].select.externalRaw, true);
  assert.equal(harness.calls.queries[0].select.property.select.status, true);

  const update = harness.calls.updates[0];
  assert.equal(update.where.id, "reservation-demo-1");
  assert.equal(update.data.verificationStatus, "COMPLETED");
  assert.equal(update.data.preferredLanguage, "es");
  assert.equal(
    update.data.guestAccessModeSnapshot,
    "PASSCODE_PLUS_NFC"
  );
  assert.equal(update.data.externalRaw.demo, true);
  assert.equal(update.data.externalRaw.paymentSimulated, true);
  assert.equal(update.data.externalRaw.created_by, "platform@example.com");
  assert.deepEqual(
    update.data.externalRaw.consent,
    {
      stayNotificationsConsent: true,
      smsConsent: true,
      consentSource:
        "INTERNAL_DEMO_CENTER",
      consentVersion:
        "stay_notifications_v1",
      acceptedAt: now.toISOString(),
    }
  );
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
  assert.equal(audit.metadata.preferredLanguage, "es");
  assert.equal(audit.metadata.smsConsent, true);
  assert.equal(
    audit.metadata.guestAccessMode,
    "PASSCODE_PLUS_NFC"
  );
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
  assert.equal(update.data.preferredLanguage, "en");
  assert.equal(
    update.data.externalRaw.consent.smsConsent,
    false
  );
  assert.equal(
    update.data.externalRaw.consent.acceptedAt,
    null
  );
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

const deniedIdentities: Array<[string, Parameters<typeof buildHarness>[0]]> = [
  ["missing source", { source: null }],
  ["commercial Direct Booking", { source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT" }],
  ["manual source with demo-looking ID", { source: "MANUAL" }],
  ["Channex source with demo-looking ID", { source: "AIRBNB", externalProvider: "CHANNEX" }],
  ["legacy Lodgify demo", { source: "LODGIFY", externalProvider: "LODGIFY" }],
  ["native source but Lodgify provider", { externalProvider: "LODGIFY" }],
  ["missing provider", { externalProvider: null }],
  ["missing external ID", { externalId: null }],
  ["missing simulation metadata", { externalRaw: null }],
  ["array instead of metadata", { externalRaw: [] }],
  ["text instead of metadata", { externalRaw: "demo" }],
  ["missing demo flag", { externalRaw: { paymentSimulated: true } }],
  ["false demo flag", { externalRaw: { demo: false, paymentSimulated: true } }],
  ["string demo flag", { externalRaw: { demo: "true", paymentSimulated: true } }],
  ["missing payment simulation", { externalRaw: { demo: true } }],
  ["false payment simulation", { externalRaw: { demo: true, paymentSimulated: false } }],
  ["string payment simulation", { externalRaw: { demo: true, paymentSimulated: "true" } }],
];
for (const [label, input] of deniedIdentities) {
  test(`native pre-check-in rejects ${label} without writes`, async () => {
    const h = buildHarness(input);
    await assert.rejects(completeInternalDemoSecurePrecheckin(h.prisma, {
      reservationId: "reservation-demo-1", actor: h.actor, now,
    }, h.dependencies), /INTERNAL_DEMO_RESERVATION_REQUIRED/);
    assert.equal(h.calls.transaction, 0);
    assert.equal(h.calls.updates.length, 0);
    assert.equal(h.calls.audits.length, 0);
    assert.equal(h.calls.completeJourney, 0);
  });
}
for (const input of [{ propertyId: "ordinary-property" }, { propertyStatus: "INACTIVE" }]) {
  test(`native pre-check-in requires the dedicated active demo property: ${JSON.stringify(input)}`, async () => {
    const h = buildHarness(input);
    await assert.rejects(completeInternalDemoSecurePrecheckin(h.prisma, {
      reservationId: "reservation-demo-1", actor: h.actor, now,
    }, h.dependencies), /INTERNAL_DEMO_PROPERTY_REQUIRED/);
    assert.equal(h.calls.transaction, 0);
    assert.equal(h.calls.updates.length, 0);
    assert.equal(h.calls.audits.length, 0);
  });
}

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

// Route ordering and payment-free delivery are exercised through real services
// and disposable PostgreSQL in internal-demo-commercial.db.test.ts.

test("Demo Direct Booking parity uses canonical reservation numbers, guest portal eligibility, and one primary host recipient", async () => {
  const paritySource = await readFile(
    new URL("./internal-demo-direct-booking-parity.service.ts", import.meta.url),
    "utf8"
  );
  const guestPortalSource = await readFile(
    new URL("./guest-cancellation.service.ts", import.meta.url),
    "utf8"
  );
  const directBookingSource = await readFile(
    new URL("./direct-booking.service.ts", import.meta.url),
    "utf8"
  );
  const organizationEmailSource = await readFile(
    new URL("./organization-guest-email.service.ts", import.meta.url),
    "utf8"
  );

  assert.match(paritySource, /generateReservationNumber\(prisma\)/);
  assert.match(
    paritySource,
    /reservationNumber:\s*canonicalReservationNumber/
  );
  assert.match(
    guestPortalSource,
    /reservation\.source\s*===\s*"INTERNAL_DEMO_DIRECT_BOOKING"/
  );
  assert.match(
    paritySource,
    /resolveOrganizationPrimaryAdmin\(/
  );
  assert.doesNotMatch(
    paritySource,
    /dashboardUser\.findMany/
  );
  assert.match(
    directBookingSource,
    /resolveOrganizationPrimaryAdmin\(/
  );
  assert.match(
    organizationEmailSource,
    /role:\s*DashboardUserRole\.ORG_ADMIN[\s\S]*createdAt:\s*"asc"/
  );
  assert.match(
    organizationEmailSource,
    /findFirst\(/
  );
});
