import type { PrismaClient } from "@prisma/client";
import type { CleaningFollowupReceiptStore } from "./cleaning-followup-receipt.service.js";

export function createCleaningFollowupReceiptStore(
  prisma: Pick<PrismaClient, "cleaningFollowupReceipt">,
): CleaningFollowupReceiptStore {
  return {
    async claim(input) {
      // Periodic scans and concurrent workers may encounter the same due key.
      // Only the insert owner claims delivery; replays leave the receipt intact.
      const created = await prisma.cleaningFollowupReceipt.createMany({
        data: [{ cleaningWorkId: input.cleaningWorkId, kind: input.kind, dueAt: input.dueAt }],
        skipDuplicates: true,
      });
      const receipt = await prisma.cleaningFollowupReceipt.findUniqueOrThrow({
        where: { cleaningWorkId_kind_dueAt: input },
        select: { id: true },
      });
      return { status: created.count === 1 ? "CLAIMED" : "ALREADY_CLAIMED", receiptId: receipt.id };
    },
  };
}
