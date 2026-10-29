import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { archiveExpiredDemoCleaning, readDemoCleaningBlockers } from "./internal-demo-cleaning-recovery.service.js";
import { INTERNAL_DEMO_PROPERTY_ID } from "./internal-demo-scope.js";

const now = new Date("2026-10-29T16:00:00Z");
const actor = { role: "PLATFORM_ADMIN", userId: "operator", organizationId: "org" };
function fixture() {
  const work = { id: "work", propertyId: INTERNAL_DEMO_PROPERTY_ID, reservationId: "reservation", staffMemberId: "staff",
    confirmationId: "offer", scheduledStartAt: new Date("2026-10-19T12:21:00Z"), durationCommitmentMinutes: 30,
    startConfirmedAt: new Date("2026-10-19T12:31:00Z"), completionConfirmedAt: null as Date | null,
    cancelledAt: null as Date | null, supersededAt: null as Date | null };
  const reservation = { id: "reservation", reservationNumber: "PG-SYNTHETIC", propertyId: INTERNAL_DEMO_PROPERTY_ID,
    checkOut: new Date("2026-10-19T12:11:00Z"), source: "INTERNAL_DEMO_DIRECT_BOOKING", externalProvider: "PIN_GO_INTERNAL_DEMO",
    externalId: "DEMO-synthetic", externalRaw: { demo: true, paymentSimulated: true }, totalAmount: 0,
    stripeCheckoutSessionId: null as string | null, stripePaymentIntentId: null as string | null,
    property: { status: "ACTIVE", organizationId: "org", cleaningStartOffsetMinutes: 10 } };
  const writes: unknown[] = [];
  let audit: unknown = null;
  const options = { foreign: false, futureCredential: false, confirmationStatus: "CONFIRMED" };
  const tx = {
    $queryRaw: async () => [{ id: "locked" }],
    reservation: { findFirst: async ({ where }: any) => {
      assert.equal(where.property.organizationId, actor.organizationId);
      return options.foreign ? null : reservation;
    } },
    nfcAssignment: { findFirst: async () => options.futureCredential ? { id: "future" } : null },
    cleaningWork: {
      findMany: async () => [work], findUnique: async () => work, findUniqueOrThrow: async () => work,
      update: async ({ data }: any) => { writes.push(data); Object.assign(work, data); return work; },
    },
    cleaningConfirmation: { updateMany: async ({ where, data }: any) => {
      assert.deepEqual(where, { id: "offer", reservationId: "reservation", propertyId: INTERNAL_DEMO_PROPERTY_ID, staffMemberId: "staff", status: "CONFIRMED" });
      if (options.confirmationStatus !== "CONFIRMED") return { count: 0 };
      writes.push(data); return { count: 1 };
    } },
    apmsAuditEntry: { findUnique: async () => audit, create: async ({ data }: any) => { audit = data; return data; } },
  };
  const db = { ...tx, $transaction: async (run: (client: unknown) => unknown) => run(tx) } as unknown as PrismaClient;
  return { db, work, reservation, writes, options, audit: () => audit };
}

test("expired Demo abandonment preserves start, never invents completion or changes hardware, and is idempotent", async () => {
  const f = fixture();
  assert.deepEqual((await readDemoCleaningBlockers(f.db, actor, "staff", now))[0], {
    workId: "work", reservationNumber: "PG-SYNTHETIC", startedAt: f.work.startConfirmedAt, canArchive: true,
  });
  assert.equal(f.writes.length, 0, "preparation is read-only");
  const start = f.work.startConfirmedAt;
  assert.deepEqual(await archiveExpiredDemoCleaning(f.db, actor, "work", now), { replayed: false });
  assert.equal(f.work.startConfirmedAt, start);
  assert.equal(f.work.completionConfirmedAt, null);
  assert.deepEqual(f.writes, [{ status: "CANCELLED" }, { cancelledAt: now }]);
  assert.equal((f.audit() as any).reason, "DEMO_TEST_ABANDONED");
  assert.equal((f.audit() as any).metadata.actorUserId, actor.userId);
  assert.equal((f.audit() as any).metadata.completionRecorded, false);
  assert.deepEqual(await archiveExpiredDemoCleaning(f.db, actor, "work", now), { replayed: true });
  assert.equal(f.writes.length, 2);
});

for (const scenario of ["role", "organization", "property", "commercial", "charged", "future-window", "future-credential", "completed", "superseded", "changed-offer"] as const) {
  test(`administrative recovery rejects ${scenario} without writes`, async () => {
    const f = fixture(); let who = actor;
    if (scenario === "role") who = { ...actor, role: "ORG_ADMIN" };
    if (scenario === "organization") f.options.foreign = true;
    if (scenario === "property") f.work.propertyId = "commercial-property";
    if (scenario === "commercial") f.reservation.source = "DIRECT_BOOKING";
    if (scenario === "charged") f.reservation.stripeCheckoutSessionId = "cs_live_synthetic";
    if (scenario === "future-window") f.work.scheduledStartAt = new Date(now.getTime() + 3600000);
    if (scenario === "future-credential") f.options.futureCredential = true;
    if (scenario === "completed") f.work.completionConfirmedAt = now;
    if (scenario === "superseded") f.work.supersededAt = now;
    if (scenario === "changed-offer") f.options.confirmationStatus = "REASSIGNED";
    await assert.rejects(archiveExpiredDemoCleaning(f.db, who, "work", now));
    assert.equal(f.writes.length, 0); assert.equal(f.audit(), null);
  });
}
