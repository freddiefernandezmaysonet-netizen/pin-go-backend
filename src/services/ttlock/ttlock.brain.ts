import { prisma } from "../../lib/prisma";
import { AccessMethod, AccessStatus } from "@prisma/client";
import {
  ttlockGetPasscode,
  ttlockDeletePasscode,
} from "../../ttlock/ttlock.passcode";
import { ttlockChangeCardPeriod } from "../../ttlock/ttlock.card";
import { getOrgTtlockAccessToken } from "../../services/ttlock/ttlock.org-auth";

function maskCode(code: string) {
  if (code.length <= 2) return "**";
  return `${code.slice(0, 2)}*****`;
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function resolveGrantAccessToken(propertyId?: string | null) {
  if (!propertyId) return undefined;

  try {
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { organizationId: true },
    });

    if (!property?.organizationId) return undefined;

    return await getOrgTtlockAccessToken(
      prisma,
      property.organizationId
    ).catch(() => undefined);
  } catch {
    return undefined;
  }
}

export async function activateGrant(grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    include: {
      lock: true,
      reservation: true,
      person: true,
    },
  });

  if (!grant) throw new Error("AccessGrant not found");

  if (grant.status !== AccessStatus.PENDING) {
    return { skipped: true, reason: `Grant not pending (${grant.status})` };
  }

  if (!grant.lock?.ttlockLockId) {
    throw new Error("Grant has no TTLock lock assigned");
  }

  const accessToken = await resolveGrantAccessToken(grant.lock.propertyId);

  let nfcResult: any = null;

  if (grant.method === AccessMethod.NFC_TIMEBOUND) {
    const cardId = toIntOrNull(grant.ttlockRefId);
    if (!cardId) {
      throw new Error("NFC_TIMEBOUND grant missing numeric ttlockRefId (cardId)");
    }

    nfcResult = await ttlockChangeCardPeriod({
      lockId: Number(grant.lock.ttlockLockId),
      cardId,
      startDate: grant.startsAt.getTime(),
      endDate: grant.endsAt.getTime(),
      changeType: 2,
      accessToken,
    });
  }

  let keyboardPwdId: number | null = null;
  let code: string | null = null;
  let otpPayload: any = null;

if (grant.method === AccessMethod.PASSCODE_TIMEBOUND) {
  // Validar fechas
  const startDate = grant.startsAt?.getTime();
  const endDate = grant.endsAt?.getTime();

  if (!startDate || !endDate || endDate <= startDate) {
    console.warn("[activateGrant] invalid dates, fallback to TTLock default OTP", {
      grantId: grant.id,
      startsAt: grant.startsAt,
      endsAt: grant.endsAt,
    });
  }

  console.log("[ACCESS][PASSCODE] grant window", {
    grantId: grant.id,
    reservationId: grant.reservationId,
    propertyId: grant.lock?.propertyId ?? null,
    startsAt_raw: grant.startsAt,
    endsAt_raw: grant.endsAt,
    startsAt_iso: grant.startsAt?.toISOString?.() ?? null,
    endsAt_iso: grant.endsAt?.toISOString?.() ?? null,
    startsAt_ms: grant.startsAt?.getTime?.() ?? null,
    endsAt_ms: grant.endsAt?.getTime?.() ?? null,
  });

  const pass = await ttlockGetPasscode({
    lockId: Number(grant.lock.ttlockLockId),

    // 👇 CAMBIO CLAVE
    keyboardPwdType: 3, // ← PERIOD password (controlado por fechas)

    name: grant.reservation?.guestName
      ? `PinGo ${String(grant.reservation.guestName).slice(0, 20)}`
      : "PinGo Guest",

    // 👇 NUEVO
    startDate: startDate,
    endDate: endDate,

    accessToken,
  });

  keyboardPwdId = pass?.keyboardPwdId ? Number(pass.keyboardPwdId) : null;
  code = pass?.keyboardPwd ? String(pass.keyboardPwd) : null;
  otpPayload = pass;

  if (!code) {
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.FAILED,
        lastError: "TTLock did not return keyboardPwd",
        ttlockPayload: {
          ...(grant.ttlockPayload as any),
          activatedAt: Date.now(),
          otp: otpPayload,
          nfc: nfcResult,
        },
      },
    });

    return { ok: false, reason: "No passcode returned" };
  }
}

    await prisma.accessGrant.update({
    where: { id: grant.id },
    data: {
      status: AccessStatus.ACTIVE,
      ttlockKeyboardPwdId: keyboardPwdId,
      accessCodeMasked: code ? maskCode(code) : null,
      lastError: null,
      ttlockPayload: {
        ...(grant.ttlockPayload as any),
        activatedAt: Date.now(),
        otp: otpPayload ? { keyboardPwdId, raw: otpPayload } : null,
        nfc: nfcResult ?? null,
      },
    },
  });

  return { ok: true, passcodePlain: code ?? null };
}

export async function deactivateGrant(grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    include: {
      lock: true,
    },
  });

  if (!grant) throw new Error("AccessGrant not found");

  if (grant.status !== AccessStatus.ACTIVE) {
    return { skipped: true, reason: `Grant not active (${grant.status})` };
  }

  if (!grant.lock?.ttlockLockId) {
    throw new Error("Grant has no TTLock lock assigned");
  }

  const accessToken = await resolveGrantAccessToken(grant.lock.propertyId);

  let nfcResult: any = null;

  if (grant.method === AccessMethod.NFC_TIMEBOUND) {
    const cardId = toIntOrNull(grant.ttlockRefId);
    if (!cardId) {
      throw new Error("NFC_TIMEBOUND grant missing numeric ttlockRefId (cardId)");
    }

    const now = Date.now();

    nfcResult = await ttlockChangeCardPeriod({
      lockId: Number(grant.lock.ttlockLockId),
      cardId,
      startDate: now,
      endDate: now,
      changeType: 2,
      accessToken,
    });
  }

  if (
    grant.method === AccessMethod.PASSCODE_TIMEBOUND &&
    grant.ttlockKeyboardPwdId
  ) {
    try {
      await ttlockDeletePasscode({
        lockId: Number(grant.lock.ttlockLockId),
        keyboardPwdId: Number(grant.ttlockKeyboardPwdId),
        deleteType: Number(process.env.TTLOCK_DELETE_TYPE ?? 2),
        accessToken,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);

      if (!msg.includes("errcode=-3")) {
        throw e;
      }
    }
  }

  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: {
      status: AccessStatus.REVOKED,
      lastError: null,
      ttlockPayload: {
        ...(grant.ttlockPayload as any),
        revokedAt: Date.now(),
        nfc: nfcResult,
      },
    },
  });

  return { ok: true };
}