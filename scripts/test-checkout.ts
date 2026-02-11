async function fetchDueCheckouts(now: Date) {
  // ✅ Checkout basado en AccessGrant expirado (endsAt <= now) y ACTIVE
  return prisma.reservation.findMany({
    where: {
      accessGrants: {
        some: {
          status: AccessStatus.ACTIVE,
          endsAt: { lte: now },
        },
      },
    },
    take: BATCH_SIZE,
    orderBy: { updatedAt: 'asc' },
    include: {
      accessGrants: {
        where: {
          status: AccessStatus.ACTIVE,
          endsAt: { lte: now },
        },
        orderBy: { endsAt: 'asc' },
        take: 10,
        include: { lock: true },
      },
    },
  });
}
