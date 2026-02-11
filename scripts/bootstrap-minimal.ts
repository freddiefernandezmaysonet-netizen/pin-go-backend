import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('DB CHECK: Property count =', await prisma.property.count().catch(() => 'no model?'));
  console.log('DB CHECK: Lock count =', await prisma.lock.count().catch(() => 'no model?'));

  try {
    console.log('\nTrying to create minimal Property...');
    // @ts-ignore
    const p = await prisma.property.create({ data: {} });
    console.log('✅ Created Property:', p.id);
  } catch (e: any) {
    console.error('\n❌ Property create failed (expected). Paste this error to me:\n');
    console.error(e?.message ?? e);
  }

  try {
    console.log('\nTrying to create minimal Lock...');
    // @ts-ignore
    const l = await prisma.lock.create({ data: {} });
    console.log('✅ Created Lock:', l.id);
  } catch (e: any) {
    console.error('\n❌ Lock create failed (expected). Paste this error to me:\n');
    console.error(e?.message ?? e);
  }
}

main()
  .catch((e) => console.error('Fatal:', e?.message ?? e))
  .finally(async () => {
    await prisma.$disconnect();
  });
