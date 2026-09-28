import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { CleaningFollowupReceiptStore } from "./cleaning-followup-receipt.service.js";

export function createCleaningFollowupReceiptStore(
  prisma: Pick<PrismaClient, "cleaningFollowupReceipt">,
): CleaningFollowupReceiptStore {
  return {
    async claim(input) {
      try {
        await prisma.cleaningFollowupReceipt.create({
          data: {
            cleaningWorkId: input.cleaningWorkId,
            kind: input.kind,
            dueAt: input.dueAt,
          },
        });
        return "CLAIMED";
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return "ALREADY_CLAIMED";
        }
        throw error;
      }
    },
  };
}
