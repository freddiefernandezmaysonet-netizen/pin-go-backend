import type { PrismaClient } from "@prisma/client";

export async function queueCleaningHostAttentionNotice(
  prisma: PrismaClient,
  cleaningWorkId: string,
  reasonCode?: string,
) {
  try {
    return await prisma.cleaningHostAttentionNotice.create({
      data: { cleaningWorkId, status: "QUEUED", ...(reasonCode ? { reasonCode } : {}) },
    });
  } catch (error: any) {
    if (error?.code !== "P2002") throw error;
    return prisma.cleaningHostAttentionNotice.findUniqueOrThrow({ where: { cleaningWorkId } });
  }
}
