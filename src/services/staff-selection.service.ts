import { PrismaClient, PropertyStaffRole } from "@prisma/client";

const prisma = new PrismaClient();

export async function selectNextStaffForProperty(params: {
  propertyId: string;
  excludeStaffIds?: string[];
}) {
  const { propertyId, excludeStaffIds = [] } = params;

  const staffList = await prisma.propertyStaff.findMany({
    where: {
      propertyId,
      isActive: true,
      staffMember: {
        isActive: true,
        phoneE164: { not: null },
      },
    },
    include: {
      staffMember: true,
    },
  });

  if (!staffList.length) return null;

  // 1️⃣ PRIMARY primero
  const primary = staffList.find(
    (s) =>
      s.role === PropertyStaffRole.PRIMARY &&
      !excludeStaffIds.includes(s.staffMemberId)
  );

  if (primary) return primary.staffMember;

  // 2️⃣ BACKUPS ordenados
  const backups = staffList
    .filter(
      (s) =>
        s.role === PropertyStaffRole.BACKUP &&
        !excludeStaffIds.includes(s.staffMemberId)
    )
    .sort((a, b) => (a.backupOrder ?? 0) - (b.backupOrder ?? 0));

  if (backups.length > 0) {
    return backups[0].staffMember;
  }

  return null;
}