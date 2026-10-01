import type { PrismaClient } from "@prisma/client";

const PREFIX = "CLEANING_FOLLOWUP_";

export async function reconcileCleaningFollowupDeliveryEvidence(
  prisma: PrismaClient,
  now = new Date(),
) {
  const receipts = await prisma.cleaningFollowupReceipt.findMany({
    where: {
      deliveryStatus: "FAILED",
      kind: { in: ["START_REMINDER", "COMPLETION_REMINDER"] },
    },
    orderBy: { dueAt: "asc" },
    take: 100,
  });

  let reconciled = 0;
  for (const receipt of receipts) {
    const work = await prisma.cleaningWork.findUnique({
      where: { id: receipt.cleaningWorkId },
      select: { reservationId: true, staffMemberId: true },
    });
    if (!work) continue;
    const staff = await prisma.staffMember.findUnique({
      where: { id: work.staffMemberId },
      select: { phoneE164: true },
    });
    if (!staff?.phoneE164) continue;

    const message = await prisma.messageLog.findFirst({
      where: {
        reservationId: work.reservationId,
        to: staff.phoneE164,
        channel: "sms",
        provider: "twilio",
        status: "SENT",
        communicationType: `${PREFIX}${receipt.kind}`,
        createdAt: { gte: receipt.claimedAt },
      },
      orderBy: { createdAt: "desc" },
      select: { providerMessageId: true, deliveredAt: true },
    });
    if (!message) continue;

    await prisma.cleaningFollowupReceipt.updateMany({
      where: { id: receipt.id, deliveryStatus: "FAILED" },
      data: {
        deliveryStatus: "SENT",
        // Use provider delivery evidence when available, otherwise the time
        // SENT was observed by reconciliation (not the original failed log time).
        deliveredAt: message.deliveredAt ?? now,
        providerMessageId: message.providerMessageId,
        lastError: null,
      },
    });
    reconciled++;
  }
  return { scanned: receipts.length, reconciled };
}
