import type { Request, Response } from 'express';
import {
  AccessMethod,
  AccessStatus,
  CancellationActor,
  PrismaClient,
  ReservationStatus,
} from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { ttlockDeletePasscode } from '../integrations/ttlock/ttlock.passcode';
import { persistChannexAriReservationIntent } from '../pms/outbound/channex-ari-reservation-producer.service';

const prisma = new PrismaClient();

type PatchBody =
  | { action: 'CANCEL' }
  | { action: 'REVOKE_ACCESS' }
  | { action: 'UPDATE_GUEST'; guestName?: string; guestEmail?: string; guestPhone?: string }
  | Record<string, any>;

async function revokeGrantInProvider(grant: any, organizationId: string) {
  // Solo implementado para PASSCODE_TIMEBOUND (keyboardPwd)
  if (grant.method !== AccessMethod.PASSCODE_TIMEBOUND) return;

  if (!grant?.lock?.ttlockLockId) {
    throw new Error('Lock.ttlockLockId missing on grant.lock');
  }
  if (!grant.ttlockKeyboardPwdId) {
    throw new Error('ttlockKeyboardPwdId missing for PASSCODE_TIMEBOUND');
  }

  await ttlockDeletePasscode({
    ttlockLockId: grant.lock.ttlockLockId,
    passcodeId: grant.ttlockKeyboardPwdId,
    organizationId,
  });
}

export async function patchReservationHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = (req.body ?? {}) as PatchBody;

    // 1) Validar existencia de la reserva
    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        property: {
          select: {
            organizationId: true,
          },
        },
        accessGrants: {
          include: { lock: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reservation not found' });
    }

    // 2) Acciones soportadas
    const action = (body as any).action;

    if (action === 'UPDATE_GUEST') {
      const updated = await prisma.reservation.update({
        where: { id },
        data: {
          guestName: (body as any).guestName ?? reservation.guestName,
          guestEmail: (body as any).guestEmail ?? reservation.guestEmail,
          guestPhone: (body as any).guestPhone ?? reservation.guestPhone,
        },
      });
      return res.json({ ok: true, action, reservation: updated });
    }

    if (action !== 'CANCEL' && action !== 'REVOKE_ACCESS') {
      return res.status(400).json({
        ok: false,
        error: `Unsupported action. Use one of: CANCEL | REVOKE_ACCESS | UPDATE_GUEST`,
      });
    }

    if (action === 'CANCEL') {
      const cancelledAt = new Date();

      await prisma.$transaction(async (tx) => {
        const currentReservation = await tx.reservation.findUnique({
          where: { id },
          include: {
            property: {
              select: {
                organizationId: true,
                timezone: true,
                distributionEnabled: true,
                distributionStatus: true,
              },
            },
          },
        });

        if (!currentReservation) {
          throw new Error('Reservation not found');
        }

        if (currentReservation.status === ReservationStatus.CANCELLED) {
          return;
        }

        const cancellationUpdate = await tx.reservation.updateMany({
          where: {
            id,
            status: ReservationStatus.ACTIVE,
          },
          data: {
            status: ReservationStatus.CANCELLED,
            cancelledAt,
            cancelledBy: CancellationActor.HOST,
            cancelledByUserId: null,
            cancellationRequestedAt: cancelledAt,
            cancellationRequestedBy: CancellationActor.HOST,
            cancellationReason: 'Legacy host cancellation',
          },
        });

        if (cancellationUpdate.count === 0) {
          return;
        }

        if (
          currentReservation.property.distributionEnabled === true &&
          currentReservation.property.distributionStatus === 'ACTIVE'
        ) {
          const propertyTimezone =
            currentReservation.property.timezone ?? 'America/Puerto_Rico';

          await persistChannexAriReservationIntent({
            db: tx,
            organizationId: currentReservation.property.organizationId,
            propertyId: currentReservation.propertyId,
            reservationId: currentReservation.id,
            previous: {
              checkIn: currentReservation.checkIn,
              checkOut: currentReservation.checkOut,
              status: 'ACTIVE',
            },
            current: {
              checkIn: currentReservation.checkIn,
              checkOut: currentReservation.checkOut,
              status: 'CANCELLED',
            },
            propertyTimezone,
            todayDateKey: formatInTimeZone(
              cancelledAt,
              propertyTimezone,
              'yyyy-MM-dd'
            ),
            now: cancelledAt,
          });
        }
      });
    }

    // 3) Revocar todos los grants ACTIVE de esa reserva
    const activeGrants = reservation.accessGrants.filter((g) => g.status === AccessStatus.ACTIVE);

    if (activeGrants.length === 0) {
      const refreshed = await prisma.reservation.findUnique({
        where: { id },
        include: {
          property: true,
          accessGrants: {
            include: { lock: true },
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      return res.json({
        ok: true,
        action,
        message: 'No ACTIVE grants to revoke',
        revokedCount: 0,
        reservation: refreshed,
      });
    }

    let revoked = 0;
    const errors: Array<{ grantId: string; error: string }> = [];

    for (const grant of activeGrants) {
      try {
        // Revocar en TTLock si aplica
        await revokeGrantInProvider(grant, reservation.property.organizationId);

        // Marcar como REVOKED (idempotente: solo si sigue ACTIVE)
        const upd = await prisma.accessGrant.updateMany({
          where: { id: grant.id, status: AccessStatus.ACTIVE },
          data: { status: AccessStatus.REVOKED, lastError: null },
        });

        revoked += upd.count;
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        errors.push({ grantId: grant.id, error: msg });

        // Marcar FAILED (para revisión), pero no rompe el loop
        await prisma.accessGrant.update({
          where: { id: grant.id },
          data: { status: AccessStatus.FAILED, lastError: `REVOKE_FAILED: ${msg}` },
        });
      }
    }

    // 4) Devuelve estado actualizado
    const refreshed = await prisma.reservation.findUnique({
      where: { id },
      include: {
        property: true,
        accessGrants: { include: { lock: true }, orderBy: { createdAt: 'desc' } },
      },
    });

    return res.json({
      ok: true,
      action,
      revokedCount: revoked,
      errors,
      reservation: refreshed,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
}
