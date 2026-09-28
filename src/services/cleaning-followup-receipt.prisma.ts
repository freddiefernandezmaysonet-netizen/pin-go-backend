import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { CleaningFollowupReceiptStore } from "./cleaning-followup-receipt.service.js";

export function createCleaningFollowupReceiptStore(
  prisma: Pick<PrismaClient, "cleaningFollowupReceipt">,
): CleaningFollowupReceiptStore {
  return {
    async claim(input) {
      try {
        const created = await prisma.cleaningFollowupReceipt.create({
          data: {
            cleaningWorkId: input.cleaningWorkId,
            kind: input.kind,
            dueAt: input.dueAt,
          },
        });
        return { status: "CLAIMED", receiptId: created.id };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const existing = await prisma.cleaningFollowupReceipt.findUnique({
            where: { cleaningWorkId_kind_dueAt: input },
            select: { id: true },
          });
          if (!existing) throw error;
          return { status: "ALREADY_CLAIMED", receiptId: existing.id };
        }
        throw error;
      }
    },
  };
}
