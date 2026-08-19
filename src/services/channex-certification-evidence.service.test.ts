import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { collectChannexCertificationEvidence } from "./channex-certification-evidence.service";

type AuditFixture = {
  status: "SUCCESS";
  reason: string;
  metadata: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  createdAt: Date;
};

type ReservationFixture = {
  id: string;
  reservationNumber: string;
  status: "ACTIVE";
  externalProvider: "CHANNEX";
  externalId: string;
  externalUpdatedAt: Date;
  lastIngestError: null;
  checkIn: Date;
  checkOut: Date;
  paymentState: "PAID";
  createdAt: Date;
  updatedAt: Date;
};

function auditFixture(args: {
  reason: string;
  ingestMechanism?: string;
  startedAt?: string;
  completedAt?: string;
}): AuditFixture {
  const startedAt = new Date(
    args.startedAt ?? "2026-08-09T01:00:00.000Z"
  );
  const completedAt = new Date(
    args.completedAt ?? "2026-08-09T01:00:01.000Z"
  );

  return {
    status: "SUCCESS",
    reason: args.reason,
    metadata: {
      bookingId: "booking-001",
      revisionId: "revision-001",
      propertyId: "pin-go-property-001",
      channexPropertyId: "channex-property-001",
      ...(args.ingestMechanism
        ? { ingestMechanism: args.ingestMechanism }
        : {}),
    },
    startedAt,
    completedAt,
    createdAt: startedAt,
  };
}

async function withAuditFixtures<T>(args: {
  persistence: AuditFixture | null;
  acknowledgement: AuditFixture | null;
  reservation?: ReservationFixture | null;
  reservationCount?: number;
  run: () => Promise<T>;
}) {
  const auditDelegate = prisma.apmsAuditEntry as any;
  const reservationDelegate = prisma.reservation as any;
  const connectionDelegate = prisma.pmsConnection as any;
  const originalFindUnique = auditDelegate.findUnique;
  const originalReservationFindUnique = reservationDelegate.findUnique;
  const originalReservationCount = reservationDelegate.count;
  const originalConnectionFindFirst = connectionDelegate.findFirst;

  auditDelegate.findUnique = async (query: any) => {
    const decisionId = String(query?.where?.decisionId ?? "");

    if (decisionId.endsWith(":persisted")) return args.persistence;
    if (decisionId.endsWith(":ack")) return args.acknowledgement;
    return null;
  };
  reservationDelegate.findUnique = async () => args.reservation ?? null;
  reservationDelegate.count = async () => args.reservationCount ?? 0;
  connectionDelegate.findFirst = async () => null;

  try {
    return await args.run();
  } finally {
    auditDelegate.findUnique = originalFindUnique;
    reservationDelegate.findUnique = originalReservationFindUnique;
    reservationDelegate.count = originalReservationCount;
    connectionDelegate.findFirst = originalConnectionFindFirst;
  }
}

test("collects ingest mechanism from persisted audit metadata", async () => {
  const evidence = await withAuditFixtures({
    persistence: auditFixture({
      reason: "CHANNEX_REVISION_PERSISTED",
      ingestMechanism: "BOOKING_REVISION_FEED",
      startedAt: "2026-08-09T01:00:00.000Z",
      completedAt: "2026-08-09T01:00:01.000Z",
    }),
    acknowledgement: auditFixture({
      reason: "CHANNEX_REVISION_ACKNOWLEDGED",
      ingestMechanism: "BOOKING_REVISION_FEED",
      startedAt: "2026-08-09T01:00:02.000Z",
      completedAt: "2026-08-09T01:00:03.000Z",
    }),
    reservation: {
      id: "reservation-001",
      reservationNumber: "PG-2026-000100",
      status: "ACTIVE",
      externalProvider: "CHANNEX",
      externalId: "booking-001",
      externalUpdatedAt: new Date("2026-08-09T01:00:00.000Z"),
      lastIngestError: null,
      checkIn: new Date("2026-11-01T20:00:00.000Z"),
      checkOut: new Date("2026-11-03T15:00:00.000Z"),
      paymentState: "PAID",
      createdAt: new Date("2026-08-09T01:00:00.500Z"),
      updatedAt: new Date("2026-08-09T01:00:01.000Z"),
    },
    reservationCount: 1,
    run: () =>
      collectChannexCertificationEvidence({ revisionId: "revision-001" }),
  });

  assert.equal(evidence.ingest.mechanism, "BOOKING_REVISION_FEED");
  assert.equal(evidence.ingest.bookingFindEvents, 0);
  assert.equal(
    evidence.verification.persistenceBeforeAcknowledgement,
    true
  );
  assert.equal(
    evidence.persistence?.completedAt,
    "2026-08-09T01:00:01.000Z"
  );
  assert.equal(
    evidence.acknowledgement?.startedAt,
    "2026-08-09T01:00:02.000Z"
  );
  assert.equal(evidence.reservation?.reservationId, "reservation-001");
  assert.equal(evidence.reservation?.reservationCountForBooking, 1);
  assert.equal(evidence.verification.reservationMatches, true);
  assert.equal(evidence.verification.duplicateReservations, 0);
});

test("aborts when persistence and ACK report different mechanisms", async () => {
  await assert.rejects(
    withAuditFixtures({
      persistence: auditFixture({
        reason: "CHANNEX_REVISION_PERSISTED",
        ingestMechanism: "BOOKING_REVISION_FEED",
      }),
      acknowledgement: auditFixture({
        reason: "CHANNEX_REVISION_ACKNOWLEDGED",
        ingestMechanism: "BOOKING_REVISION_BY_ID",
      }),
      run: () =>
        collectChannexCertificationEvidence({ revisionId: "revision-001" }),
    }),
    /CHANNEX_BOOKING_INGEST_MECHANISM_MISMATCH:revision-001/
  );
});

test("aborts when persisted audit has no ingest mechanism", async () => {
  await assert.rejects(
    withAuditFixtures({
      persistence: auditFixture({
        reason: "CHANNEX_REVISION_PERSISTED",
      }),
      acknowledgement: null,
      run: () =>
        collectChannexCertificationEvidence({ revisionId: "revision-001" }),
    }),
    /CHANNEX_BOOKING_INGEST_MECHANISM_UNSUPPORTED:MISSING/
  );
});
