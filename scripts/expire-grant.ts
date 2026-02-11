import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const grant = await prisma.accessGrant.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { updatedAt: 'desc' },
  });

  if (!grant) throw new Error('No hay AccessGrant ACTIVE.');

  const past = new Date(Date.now() - 60_000);

  const updated = await prisma.accessGrant.update({
    where: { id: grant.id },
    data: { endsAt: past },
  });

  console.log('✅ Expired grant:', updated.id, updated.endsAt.toISOString());
  console.log('⏳ Espera el próximo tick del worker (máx 10s)...');
}

main()
  .catch((e) => console.error('❌', e.message))
  .finally(async () => prisma.$disconnect());
