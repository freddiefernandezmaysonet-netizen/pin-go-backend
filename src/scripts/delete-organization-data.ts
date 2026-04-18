import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ORG_ID = "cmnz6qmor000gqj0x8g2r2yh2";

async function countState(orgId: string) {
  const propertyIds = (
    await prisma.property.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    })
  ).map((x) => x.id);

  const reservationIds = (
    await prisma.reservation.findMany({
      where: { propertyId: { in: propertyIds } },
      select: { id: true },
    })
  ).map((x) => x.id);

  const connectionIds = (
    await prisma.pmsConnection.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    })
  ).map((x) => x.id);

  const lockIds = (
    await prisma.lock.findMany({
      where: { propertyId: { in: propertyIds } },
      select: { id: true },
    })
  ).map((x) => x.id);

  const counts = {
    properties: propertyIds.length,
    reservations: reservationIds.length,
    pmsConnections: connectionIds.length,
    locks: lockIds.length,
    accessGrantsByReservation: await prisma.accessGrant.count({
      where: { reservationId: { in: reservationIds } },
    }),
    accessGrantsByLock: await prisma.accessGrant.count({
      where: { lockId: { in: lockIds } },
    }),
    staffAssignments: await prisma.staffAssignment.count({
      where: { reservationId: { in: reservationIds } },
    }),
    nfcAssignments: await prisma.nfcAssignment.count({
      where: { reservationId: { in: reservationIds } },
    }),
    automationLogsByReservation: await prisma.automationExecutionLog.count({
      where: { reservationId: { in: reservationIds } },
    }),
    automationLogsByOrg: await prisma.automationExecutionLog.count({
      where: { organizationId: orgId },
    }),
    pmsLinks: await prisma.pmsReservationLink.count({
      where: { reservationId: { in: reservationIds } },
    }),
    webhookEvents: await prisma.webhookEventIngest.count({
      where: { connectionId: { in: connectionIds } },
    }),
    pmsListings: await prisma.pmsListing.count({
      where: { connectionId: { in: connectionIds } },
    }),
    messageLogsByOrg: await prisma.messageLog.count({
      where: { organizationId: orgId },
    }),
    automationExecutions: await prisma.automationExecution.count({
      where: { organizationId: orgId },
    }),
    propertyAutomationDevices: await prisma.propertyAutomationDevice.count({
      where: { organizationId: orgId },
    }),
    propertyAutomationSettings: await prisma.propertyAutomationSettings.count({
      where: { organizationId: orgId },
    }),
    automationRules: await prisma.automationRule.count({
      where: { organizationId: orgId },
    }),
    propertyDevices: await prisma.propertyDevice.count({
      where: { organizationId: orgId },
    }),
    deviceHealth: await prisma.deviceHealth.count({
      where: { organizationId: orgId },
    }),
    nfcCards: await prisma.nfcCard.count({
      where: { propertyId: { in: propertyIds } },
    }),
    lockGroupLocks: await prisma.lockGroupLock.count({
      where: { lockId: { in: lockIds } },
    }),
    persons: await prisma.person.count({
      where: { organizationId: orgId },
    }),
    staffMembers: await prisma.staffMember.count({
      where: { organizationId: orgId },
    }),
    subscriptions: await prisma.subscription.count({
      where: { organizationId: orgId },
    }),
    ttlockAuth: await prisma.tTLockAuth.count({
      where: { organizationId: orgId },
    }),
    dashboardUsers: await prisma.dashboardUser.count({
      where: { organizationId: orgId },
    }),
    pmsConnectionsOrg: await prisma.pmsConnection.count({
      where: { organizationId: orgId },
    }),
    organizations: await prisma.organization.count({
      where: { id: orgId },
    }),
  };

  return { propertyIds, reservationIds, connectionIds, lockIds, counts };
}

async function main() {
  console.log(`\n[delete-org] Starting cleanup for org: ${ORG_ID}\n`);
  console.log("[delete-org] DATABASE_URL =", process.env.DATABASE_URL);
  const before = await countState(ORG_ID);
  console.log("[delete-org] BEFORE", before.counts);

  await prisma.$transaction(async (tx) => {
    await tx.messageDispatchLog.deleteMany({
      where: { reservationId: { in: before.reservationIds } },
    });

    await tx.guestLinkReminderLog.deleteMany({
      where: { reservationId: { in: before.reservationIds } },
    });

    await tx.staffAssignment.deleteMany({
      where: { reservationId: { in: before.reservationIds } },
    });

    await tx.nfcAssignment.deleteMany({
      where: { reservationId: { in: before.reservationIds } },
    });

    await tx.accessGrant.deleteMany({
      where: {
        OR: [
          { reservationId: { in: before.reservationIds } },
          { lockId: { in: before.lockIds } },
        ],
      },
    });

    await tx.automationExecutionLog.deleteMany({
      where: {
        OR: [
          { organizationId: ORG_ID },
          { reservationId: { in: before.reservationIds } },
        ],
      },
    });

    await tx.pmsReservationLink.deleteMany({
      where: {
        OR: [
          { reservationId: { in: before.reservationIds } },
          { connectionId: { in: before.connectionIds } },
        ],
      },
    });

    await tx.webhookEventIngest.deleteMany({
      where: { connectionId: { in: before.connectionIds } },
    });

    await tx.pmsListing.deleteMany({
      where: { connectionId: { in: before.connectionIds } },
    });

    await tx.messageLog.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.deviceHealth.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.propertyAutomationDevice.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.propertyAutomationSettings.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.automationRule.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.propertyDevice.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.automationExecution.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.lockGroupLock.deleteMany({
      where: { lockId: { in: before.lockIds } },
    });

    await tx.lock.deleteMany({
      where: { id: { in: before.lockIds } },
    });

    await tx.nfcCard.deleteMany({
      where: { propertyId: { in: before.propertyIds } },
    });

    await tx.reservation.deleteMany({
      where: { id: { in: before.reservationIds } },
    });

    await tx.property.deleteMany({
      where: { id: { in: before.propertyIds } },
    });

    await tx.pmsConnection.deleteMany({
      where: { id: { in: before.connectionIds } },
    });

    await tx.person.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.staffMember.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.subscription.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.tTLockAuth.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.dashboardUser.deleteMany({
      where: { organizationId: ORG_ID },
    });

    await tx.organization.deleteMany({
      where: { id: ORG_ID },
    });
  });

  const after = await countState(ORG_ID);
  console.log("\n[delete-org] AFTER", after.counts);
  console.log("\n[delete-org] Cleanup completed.\n");
}

main()
  .catch((err) => {
    console.error("[delete-org] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });