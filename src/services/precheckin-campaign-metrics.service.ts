import { Prisma, type PrismaClient } from "@prisma/client";

export async function getPrecheckinCampaignMetrics(
  prisma: Pick<PrismaClient, "reservation">, organizationId: string, now = new Date(),
) {
  if (!organizationId?.trim()) throw new Error("ORGANIZATION_REQUIRED");
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const groups = await prisma.reservation.groupBy({
    by: ["currency", "status"],
    where: {
      property: { organizationId, isTestProperty: false },
      source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT",
      externalRaw: { path: ["bookingAttribution", "campaign"], equals: "precheckin_return_stay" },
      createdAt: { gte: from, lt: now }, amountCollected: { gt: 0 },
    },
    _count: { _all: true }, _sum: { amountCollected: true, amountRefunded: true },
  });
  const currencies = new Map<string, { currency: string; bookings: number; cancelled: number; collected: Prisma.Decimal; refunded: Prisma.Decimal }>();
  for (const group of groups) {
    const currency = group.currency?.trim().toUpperCase() || "UNKNOWN";
    const row = currencies.get(currency) ?? { currency, bookings: 0, cancelled: 0,
      collected: new Prisma.Decimal(0), refunded: new Prisma.Decimal(0) };
    row.bookings += group._count._all;
    if (group.status === "CANCELLED") row.cancelled += group._count._all;
    row.collected = row.collected.plus(group._sum.amountCollected ?? 0);
    row.refunded = row.refunded.plus(group._sum.amountRefunded ?? 0);
    currencies.set(currency, row);
  }
  const rows = [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(row => ({
    currency: row.currency, bookings: row.bookings, cancelled: row.cancelled,
    collected: row.collected.toFixed(2), refunded: row.refunded.toFixed(2),
    retained: row.collected.minus(row.refunded).toFixed(2),
  }));
  return { from: from.toISOString(), to: now.toISOString(), bookings: rows.reduce((sum, row) => sum + row.bookings, 0),
    cancelled: rows.reduce((sum, row) => sum + row.cancelled, 0), currencies: rows };
}
