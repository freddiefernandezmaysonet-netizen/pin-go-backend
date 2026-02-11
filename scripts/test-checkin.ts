import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1) Usa un Property existente o crea uno mínimo
  let property = await prisma.property.findFirst();
  if (!property) {
    property = await prisma.property.create({ data: { name: 'Test Property' } });
    console.log('✅ Created Property:', property.id);
  } else {
    console.log('✅ Using Property:', property.id);
  }

  // 2) Usa un Lock existente o crea uno mínimo
  let lock = await prisma.lock.findFirst();
  if (!lock) {
    lock = await prisma.lock.create({ data: { ttlockLockId: 999999 } });
    console.log('✅ Created Lock:', lock.id);
  } else {
    console.log('✅ Using Lock:', lock.id);
  }

  // 3) Fechas “infalibles”
  const checkIn = new Date('2026-01-27T00:00:00.000Z');
  const checkOut = new Date('2026-01-30T00:00:00.000Z');

  // 4) Crear Reservation
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: property.id,
      guestName: 'Test Guest',
      guestEmail: 'test@pin-go.com',
      guestPhone: '0000000000',
      roomName: 'Test Room',
      checkIn,
      checkOut,
      paymentState: 'PAID',
    },
  });

  // 5) Crear AccessGrant con método válido
  const grant = await prisma.accessGrant.create({
    data: {
      lockId: lock.id,
      reservationId: reservation.id,
      method: 'PASSCODE_TIMEBOUND', // ✅ enum AccessMethod
      status: 'PENDING',
      startsAt: checkIn,
      endsAt: checkOut,
      unlockKey: '#',
    },
  });

  console.log('✅ Reservation creada:', reservation.id);
  console.log('✅ AccessGrant creado:', grant.id, 'method=', grant.method);
  console.log('⏳ Espera el próximo tick del worker (máx 10s)...');
}

main()
  .catch((e) => console.error('❌ Error:', e?.message ?? e))
  .finally(async () => {
    await prisma.$disconnect();
  });
