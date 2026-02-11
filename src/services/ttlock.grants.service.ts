// src/services/ttlock.grants.service.ts
import { PrismaClient, AccessMethod, AccessGrantStatus } from "@prisma/client";
import { ttlockCreatePasscode } from "../ttlock/ttlock.passcode"; // custom (add)
import { ttlockGetPasscode } from "../ttlock/ttlock.passcode.get"; // OTP (get) si lo tienes
import { ttlockDeletePasscode } from "../ttlock/ttlock.passcode.delete"; // delete (si no existe, lo hacemos)

function phoneTo7Digits(phone?: string | null) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-7) : null;
}

function maskCode(code: string) {
  if (code.length <= 2) return "**";
  return `${code.slice(0, 1)}***${code.slice(-1)}`;
}

type ActivateResult =
  | { ok: true; mode: "CUSTOM" | "OTP"; codeMasked: string; ttlock: any }
  | { ok: false; error: string; details?: any };

export async function activateGrant(prisma: PrismaClient, grantId: string): Promise<ActivateResult> {
  // 1) Traer TODO lo mínimo en un query (sin includes frágiles)
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      status: true,
      method: true,
      startsAt: true,
      endsAt: true,
      accessCodeMasked: true,
      ttlockPayload: true,
      lock: {
        select: { id: true, ttlockLockId: true },
      },
      reservation: {
        select: { id: true, guestName: true, guestPhone: true },
      },
    },
  });

  if (!grant) return { ok: false, error: `Grant not found: ${grantId}` };
  if (!grant.lock?.ttlockLockId) return { ok: false, error: "Grant has no lock.ttlockLockId" };

  // Evitar duplicar activación
  if (grant.status === "ACTIVE") {
    return { ok: true, mode: "CUSTOM", codeMasked: grant.accessCodeMasked ?? "**", ttlock: { note: "already ACTIVE" } };
  }

  // 2) Marcar estado intermedio (opcional pero recomendado)
  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: { status: "ACTIVATING" as any },
  });

  try {
    const lockId = Number(grant.lock.ttlockLockId);

    // 3) Intento #1: PASSCODE CUSTOM (7 dígitos del teléfono)
    //    Solo si el método es PASSCODE_TIMEBOUND (o como lo definiste)
    if (grant.method === (AccessMethod as any).PASSCODE_TIMEBOUND) {
      const phone7 = phoneTo7Digits(grant.reservation?.guestPhone ?? null);

      if (phone7) {
        const startDate = new Date(grant.startsAt).getTime();
        const endDate = new Date(grant.endsAt).getTime();

        const ttlock = await ttlockCreatePasscode({
          lockId,
          code: phone7,
          startDate,
          endDate,
        });

        await prisma.accessGrant.update({
          where: { id: grant.id },
          data: {
            status: "ACTIVE" as any,
            accessCodeMasked: maskCode(phone7),
            ttlockPayload: {
              ...(grant.ttlockPayload as any),
              mode: "CUSTOM",
              keyboardPwdId: ttlock?.keyboardPwdId ?? ttlock?.result?.keyboardPwdId ?? null,
              lockId,
              startDate,
              endDate,
            } as any,
          },
        });

        return { ok: true, mode: "CUSTOM", codeMasked: maskCode(phone7), ttlock };
      }
    }

    // 4) Fallback: OTP (one-time password) — esto ya te abrió la puerta
    //    OJO: Esto no requiere gateway y suele aplicar bien.
    const otp = await ttlockGetPasscode({
      lockId,
      keyboardPwdType: 1,
      name: grant.reservation?.guestName ?? "PinGo Guest",
    });

    const otpCode = String(otp.keyboardPwd ?? "");
    if (!otpCode) throw new Error("TTLock OTP returned empty keyboardPwd");

    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: "ACTIVE" as any,
        accessCodeMasked: maskCode(otpCode),
        ttlockPayload: {
          ...(grant.ttlockPayload as any),
          mode: "OTP",
          keyboardPwdId: otp.keyboardPwdId ?? null,
          lockId,
        } as any,
      },
    });

    return { ok: true, mode: "OTP", codeMasked: maskCode(otpCode), ttlock: otp };
  } catch (e: any) {
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: "FAILED" as any,
        ttlockPayload: { ...(grant.ttlockPayload as any), error: e?.message ?? String(e) } as any,
      },
    });

    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function deactivateGrant(prisma: PrismaClient, grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      status: true,
      ttlockPayload: true,
      lock: { select: { ttlockLockId: true } },
    },
  });

  if (!grant) return { ok: false, error: `Grant not found: ${grantId}` };

  const lockId = Number(grant.lock?.ttlockLockId ?? 0);
  const payload = (grant.ttlockPayload ?? {}) as any;
  const keyboardPwdId = payload.keyboardPwdId;

  try {
    // Si tenemos keyboardPwdId -> delete passcode real
    if (keyboardPwdId && lockId) {
      const ttlock = await ttlockDeletePasscode({
        lockId,
        keyboardPwdId: Number(keyboardPwdId),
      });

      await prisma.accessGrant.update({
        where: { id: grant.id },
        data: {
          status: "EXPIRED" as any,
          ttlockPayload: { ...payload, deactivatedAt: Date.now(), deleteResult: ttlock } as any,
        },
      });

      return { ok: true, deleted: true, ttlock };
    }

    // Si no hay keyboardPwdId, igual marcamos EXPIRED
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: { status: "EXPIRED" as any, ttlockPayload: { ...payload, deactivatedAt: Date.now() } as any },
    });

    return { ok: true, deleted: false };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
