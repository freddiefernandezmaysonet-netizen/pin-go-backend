import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_BATCH_SIZE = 50;

export async function runDemoFollowupWorker() {
  const now = new Date();

  const followUps = await prisma.salesFollowUp.findMany({
    where: {
      status: "PENDING",
      dueAt: {
        lte: now,
      },
      bookingType: "DEMO",
    },
    include: {
      appointment: true,
    },
    orderBy: {
      dueAt: "asc",
    },
    take: DEFAULT_BATCH_SIZE,
  });

  let skippedConverted = 0;
  let readyToSend = 0;

  for (const followUp of followUps) {
    const email = followUp.appointment.email.trim().toLowerCase();

    const existingUser = await prisma.dashboardUser.findUnique({
      where: { email },
      select: { id: true },
    });

    const completedSignup = await prisma.pendingSignup.findFirst({
      where: {
        email,
        status: "COMPLETED",
      },
      select: { id: true },
    });

    const converted = Boolean(existingUser || completedSignup);

    if (converted) {
      await prisma.salesFollowUp.update({
        where: { id: followUp.id },
        data: {
          status: "SKIPPED_CONVERTED",
          completedAt: now,
          notes: "Skipped because the lead already converted.",
        },
      });

      skippedConverted++;
      continue;
    }

    await prisma.salesFollowUp.update({
      where: { id: followUp.id },
      data: {
        status: "READY_TO_SEND",
        notes: "Lead has not converted yet. Ready for sales follow-up.",
      },
    });

    readyToSend++;
  }

  console.log("[demo-followup.worker]", {
    checked: followUps.length,
    skippedConverted,
    readyToSend,
    at: now.toISOString(),
  });

  return {
    checked: followUps.length,
    skippedConverted,
    readyToSend,
  };
}