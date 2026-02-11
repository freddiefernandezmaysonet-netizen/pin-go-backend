// src/services/access.service.ts
import { PrismaClient, AccessMethod, AccessStatus } from "@prisma/client";
import { ttlockCreatePasscode, ttlockGetPasscode } from "../ttlock/ttlock.passcode";

// Helpers
function phoneTo7Digits(phone?: string | null) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-7); // ✅ 7 dígitos (sin area code)
}

function mask(code: string) {
  if (code.length <= 2) return "**";
  return ${code.slice(0, 2)}*****;
}

/**
 * Activa un AccessGrant:
 * - PASSCODE_TIMEBOUND:
 *   1) intenta CUSTOM = last 7 digits phone (period)
 *   2) si falla -> OTP one-time (type=1) (ya comprobado que abre)
 *
 * Cambia status:
 * - PENDING -> ACTIVE
 * - si falla -> FAILED (y guarda failureReason)
 */
export async function activateGrant(prisma: PrismaClient, grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    include: {
      lock: true,
      reservation: true,
      person: true,
    },
  });

  if (!grant) throw new Error(Grant not found: ${grantId});
  if (!grant.lock?.ttlockLockId) throw new Error(Grant missing lock.ttlockLockId: ${grantId});

  // Si ya está ACTIVE no hacemos nada
  if (grant.status === AccessStatus.ACTIVE) {
    return { ok: true, alreadyActive: true };
  }

  try {
    if (grant.method === AccessMethod.PASSCODE_TIMEBOUND) {
      const lockId = Number(grant.lock.ttlockLockId);

      // Ventana
      const startsAt = grant.startsAt ? new Date(grant.startsAt).getTime() : Date.now();
      const endsAt = grant.endsAt ? new Date(grant.endsAt).getTime() : startsAt + 60 * 60 * 1000;

      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
        throw new Error("Invalid startsAt/endsAt window on grant");
      }

      // 1) CUSTOM = teléfono 7 dígitos (si lo tenemos)
      const phone7 =
        phoneTo7Digits(grant.reservation?.guestPhone) ??
        phoneTo7Digits(grant.person?.phone);

      let chosen: { kind: "CUSTOM" | "OTP"; code: string; payload: any } | null = null;

      if (phone7) {
        try {
          const customRes = await ttlockCreatePasscode({
            lockId,
            code: phone7,
            startDate: startsAt,
            endDate: endsAt,
          });

          chosen = { kind: "CUSTOM", code: phone7, payload: customRes };
        } catch (e: any) {
          // seguimos a OTP
        }
      }

      // 2) OTP one-time (type=1) fallback
      if (!chosen) {
        const otp = await ttlockGetPasscode({
          lockId,
          keyboardPwdType: 1,
          name:
            grant.reservation?.guestName ||
            grant.person?.fullName ||
            "PinGo Guest",
        });

        // esperamos que otp traiga keyboardPwd
        const otpCode = String(otp.keyboardPwd ?? "");
        if (!otpCode) throw new Error("TTLock OTP did not return keyboardPwd");

        chosen = { kind: "OTP", code: otpCode, payload: otp };
      }

      // Guardar resultado en grant
      await prisma.accessGrant.update({
        where: { id: grant.id },
        data: {
          status: AccessStatus.ACTIVE,
          activatedAt: new Date(),
          accessCodeMasked: mask(chosen.code),
          // unlockKey si quieres usarlo en SMS (ej: "#")
          unlockKey: grant.unlockKey ?? "#",
          ttlockPayload: {
            ...(grant.ttlockPayload as any),
            activation: {
              kind: chosen.kind,
              codeMasked: mask(chosen.code),
              startsAt,
              endsAt,
              ttlock: chosen.payload,
            },
          },
        },
      });

      return {
        ok: true,
        method: grant.method,
        kind: chosen.kind,
        codeMasked: mask(chosen.code),
      };
    }

    // Otros métodos (AUTHORIZED_ADMIN, etc.) los añadimos luego aquí mismo.
    // Por ahora:
    throw new Error(activateGrant not implemented for method=${grant.method});
  } catch (e: any) {
    const msg = e?.message ?? String(e);

    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.FAILED,
        failureReason: msg,
      },
    });

    throw e;
  }
}

/**
 * Desactiva un AccessGrant (sin borrar registros):
 * - status -> REVOKED
 * - (opcional) revoke real en TTLock:
 *    - para NFC: cambiar periodo now-now (ya lo tienes por gateway)
 *    - para passcode: dependiendo del endpoint disponible en Open Platform
 */
export async function deactivateGrant(prisma: PrismaClient, grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    include: { lock: true },
  });

  if (!grant) return { ok: true, skipped: "not_found" };
  if (grant.status === AccessStatus.REVOKED) return { ok: true, alreadyRevoked: true };

  try {
    // Aquí luego agregamos:
    // - delete passcode / invalidate
    // - NFC revoke (changePeriod now-now)
    // - eKey revoke, etc.

    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.REVOKED,
        revokedAt: new Date(),
      },
    });

    return { ok: true, revoked: true };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.FAILED,
        failureReason: msg,
      },
    });
    throw e;
  }
}