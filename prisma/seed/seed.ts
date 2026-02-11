import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
console.log("debug organization:", typeof (prisma as any).organization);
console.log("debug organization.upsert:", typeof (prisma as any).organization?.upsert);

async function main() {
  console.log("🚀 Seed started...");

  // 1) Organization
  const org = await prisma.organization.upsert({
    where: { id: "pingo-org-1" },
    create: {
      id: "pingo-org-1",
      name: "Pin&Go",
    },
    update: {},
  });

  // 2) Property
  const property = await prisma.property.upsert({
    where: { id: "prop-1" },
    create: {
      id: "prop-1",
      organizationId: org.id,
      name: "Serena Studio at Palmas Del Mar",
      timezone: "America/Puerto_Rico",
      city: "Humacao",
      region: "PR",
      country: "US",
    },
    update: {},
  });

  // 3) Locks (TTLock IDs reales)
  const locksToCreate: { id: string; ttlockLockId: number; name: string; label: string }[] = [
    { id: "lock-master", ttlockLockId: 25387814, name: "Master Bedroom", label: "Cuarto Master" },
    { id: "lock-front", ttlockLockId: 25439884, name: "Front Door", label: "Entrada Principal" },
  ];

  for (const l of locksToCreate) {
    await prisma.lock.upsert({
      where: { ttlockLockId: l.ttlockLockId },
      create: {
        id: l.id,
        propertyId: property.id,
        ttlockLockId: l.ttlockLockId,
        ttlockLockName: l.name,
        locationLabel: l.label,
        isActive: true,
      },
      update: {
        propertyId: property.id,
        ttlockLockName: l.name,
        locationLabel: l.label,
        isActive: true,
      },
    });
  }

  // 4) LockGroup
  const group = await prisma.lockGroup.upsert({
    where: { id: "lg-1" },
    create: {
      id: "lg-1",
      organizationId: org.id,
      name: "Serena Studio - Managers",
    },
    update: {},
  });

  for (const l of locksToCreate) {
    await prisma.lockGroupLock.upsert({
      where: { lockGroupId_lockId: { lockGroupId: group.id, lockId: l.id } },
      create: { lockGroupId: group.id, lockId: l.id },
      update: {},
    });
  }

  // 5) Manager demo
  const manager = await prisma.person.upsert({
    where: { id: "mgr-1" },
    create: {
      id: "mgr-1",
      organizationId: org.id,
      role: "MANAGER",
      fullName: "Pin&Go Manager Demo",
      email: "manager@pin-go.com",
      phone: "+17870000000",
    },
    update: {},
  });

  // 6) Assign manager to group
  await prisma.managerAssignment.upsert({
    where: { personId_lockGroupId: { personId: manager.id, lockGroupId: group.id } },
    create: { personId: manager.id, lockGroupId: group.id },
    update: {},
  });

  console.log("✅ Seed complete");
  console.log({
    organizationId: org.id,
    propertyId: property.id,
    lockIds: locksToCreate.map((x) => x.id),
    lockGroupId: group.id,
    managerPersonId: manager.id,
  });
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
