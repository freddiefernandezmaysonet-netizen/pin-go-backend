import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { runIngestTransaction, assertDirectBookingIngestAvailability } from "./direct-booking-ingest-transaction";

for (const source of ["DIRECT_BOOKING", "MANUAL"]) {
for (const code of ["P2034", "40001", "40P01"]) {
  test(`${source} retries database conflict ${code} without external dispatch`, async () => {
    let attempts = 0;
    let dispatches = 0;
    const db = { $transaction: async (work: (tx: any) => Promise<number>, options: any) => {
      assert.equal(options.isolationLevel, "Serializable");
      attempts++;
      if (attempts === 1) throw new Prisma.PrismaClientKnownRequestError("synthetic conflict", {
        code: code === "P2034" ? code : "P2010", clientVersion: "test", meta: { code },
      });
      return work({});
    } } as any;
    assert.equal(await runIngestTransaction(db, source, async () => 7), 7);
    dispatches++;
    assert.equal(attempts, 2);
    assert.equal(dispatches, 1);
  });
}
}
test("retry is bounded; availability and unrelated failures are not retried", async () => {
  for (const error of [new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" }),
    new Error("DIRECT_BOOKING_PROPERTY_NO_LONGER_AVAILABLE"),
    new Prisma.PrismaClientKnownRequestError("constraint", { code: "P2002", clientVersion: "test" })]) {
    let attempts = 0;
    const db = { $transaction: async () => { attempts++; throw error; } } as any;
    await assert.rejects(runIngestTransaction(db, "DIRECT_BOOKING", async () => 0), e => e === error);
    assert.equal(attempts, error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" ? 3 : 1);
  }
});
test("OTA and unspecified ingestion retain existing transaction behavior", async () => {
  for (const source of [undefined, "CHANNEX"]) {
    let attempts = 0;
    const db = { $transaction: async (_work: unknown, options: unknown) => {
      attempts++; assert.equal(options, undefined); throw new Error("original failure");
    } } as any;
    await assert.rejects(runIngestTransaction(db, source, async () => 0), /original failure/);
    assert.equal(attempts, 1);
  }
});
test("replay and cancellation do not acquire new occupancy; a new stay fails on conflict", async () => {
  const checkIn = new Date("2026-10-10T19:00Z"), checkOut = new Date("2026-10-11T15:00Z");
  const input = { source: "DIRECT_BOOKING", propertyId: "property", checkIn, checkOut };
  const previous = { id: "existing", status: "ACTIVE" as const, checkIn, checkOut };
  const unused = {} as any;
  await assertDirectBookingIngestAvailability(unused, input, previous);
  await assertDirectBookingIngestAvailability(unused, { ...input, status: "CANCELLED" }, null);
  await assertDirectBookingIngestAvailability(unused, { ...input, source: "CHANNEX" }, null);
  let reads = 0;
  const tx = { reservation: { findFirst: async (query: any) => {
    reads++; assert.equal(query.where.id.not, "existing"); return { id: "conflict" };
  } } } as any;
  await assert.rejects(assertDirectBookingIngestAvailability(tx, { ...input, checkOut: new Date("2026-10-12T15:00Z") }, previous),
    /DIRECT_BOOKING_PROPERTY_NO_LONGER_AVAILABLE/);
  assert.equal(reads, 1);
});
