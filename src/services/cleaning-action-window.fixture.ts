/** Synthetic transaction fixture shared by action service tests. */
export function cleaningActionFixture(seed: any, nextCheckIn: Date | null = new Date("2026-09-28T20:00:00Z")) {
  let row = { propertyId: "property_1", scheduledStartAt: new Date("2026-09-28T15:30:00Z"), ...seed };
  const access = { startsAt: new Date("2026-09-28T15:30:00Z"), endsAt: new Date("2026-09-28T19:30:00Z"), status: "COMPLETED" };
  const tx = {
    $queryRaw: async () => [{ id: seed.reservationId }],
    reservation: { findFirst: async ({ where }: any) => typeof where.id === "string" ? {
      id: seed.reservationId, propertyId: row.propertyId, status: "ACTIVE", checkOut: new Date("2026-09-28T15:00:00Z"), source: null,
      property: { status: "ACTIVE", organizationId: "org_1", checkOutTime: "11:00", checkInTime: "16:00", timezone: "America/Puerto_Rico", cleaningStartOffsetMinutes: 30 },
    } : nextCheckIn ? { checkIn: nextCheckIn } : null },
    cleaningConfirmation: { findFirst: async () => ({ id: seed.confirmationId }) },
    propertyStaff: { findFirst: async () => ({ id: "property_staff_1" }) },
    staffAssignment: { findUnique: async () => access },
    cleaningTaskChecklist: { findUnique: async () => null },
    cleaningWork: {
      findFirst: async ({ where }: any) => row.id === where.id && row.reservationId === where.reservationId && row.staffMemberId === where.staffMemberId && row.confirmationId === where.confirmationId ? { ...row } : null,
      update: async ({ data }: any) => (row = { ...row, ...data }),
    },
  };
  return { db: { $transaction: async (run: any) => run(tx) } as any, tx: tx as any, read: () => row, access };
}
