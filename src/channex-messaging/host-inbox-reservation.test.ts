import assert from "node:assert/strict";
import test from "node:test";
import { attachInboxReservations } from "./host-inbox-reservation.js";
import type { Thread } from "./host-inbox.js";

const scope = { organizationId: "org-a", propertyId: "property-a" };
function thread(bookingId: string | null): Thread {
  return { id: `thread-${bookingId}`, bookingId, title: "Guest", provider: "Airbnb", isClosed: false,
    messageCount: 1, lastMessage: null, updatedAt: "2026-10-03T00:00:00Z" };
}
test("reservation display uses exact channel booking within property and organization, including historical stays", async () => {
  const queries: unknown[] = [];
  const prisma = { reservation: { async findMany(query: unknown) {
    queries.push(query); return [{ externalId: "booking-a", reservationNumber: "PG-2026-000060" }];
  } } } as any;
  const result = await attachInboxReservations(prisma, scope, [thread("booking-a"), thread("booking-b"), thread(null)]);
  assert.deepEqual(result.map(t => t.reservationNumber), ["PG-2026-000060", null, null]);
  assert.deepEqual(queries, [{ where: { propertyId: "property-a", externalProvider: "CHANNEX", externalId: { in: ["booking-a", "booking-b"] },
    property: { organizationId: "org-a" } }, select: { externalId: true, reservationNumber: true } }]);
});
test("ambiguous matches never label the conversation with an arbitrary reservation", async () => {
  const prisma = { reservation: { async findMany() { return [
    { externalId: "booking-a", reservationNumber: "old" }, { externalId: "booking-a", reservationNumber: "new" },
  ]; } } } as any;
  assert.equal((await attachInboxReservations(prisma, scope, [thread("booking-a")]))[0]!.reservationNumber, null);
});
test("inquiries do not query reservations", async () => {
  const prisma = { reservation: { async findMany() { assert.fail("Inquiry must not resolve a reservation"); } } } as any;
  assert.equal((await attachInboxReservations(prisma, scope, [thread(null)]))[0]!.reservationNumber, null);
});
