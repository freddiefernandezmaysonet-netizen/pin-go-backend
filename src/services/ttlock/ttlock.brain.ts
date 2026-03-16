import { prisma } from "../../lib/prisma";
import { AccessMethod, AccessStatus } from "@prisma/client";
import {
  ttlockGetPasscode,
  ttlockDeletePasscode,
} from "../../ttlock/ttlock.passcode";
import { ttlockChangeCardPeriod } from "../../ttlock/ttlock.card";
import { ttlockRefreshAccessToken } from "../../ttlock/ttlock.service";

function maskCode(code: string) {
  if (code.length <= 2) return "**";
  return `${code.slice(0, 2)}*****`;
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function resolveGrantAccessToken(lockPropertyId: string) {
  const property = await prisma.property.findUnique({
    where: { id: lockPropertyId },
    select: { organizationId: true },
  });

  const organizationId = property?.organizationId ?? null;

  console.log("TTLOCK GRANT DEBUG property->org", {
    lockPropertyId,
    organizationId,
  });

  if (!organizationId) {
    throw new Error("Could not resolve organizationId from grant lock property");
  }

  const auth = await prisma.tTLockAuth.findUnique({
    where: { organizationId },
    select: {
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      uid: true,
    },
  });

  console.log("TTLOCK AUTH DEBUG", {
    organizationId,
    hasAccessToken: !!auth?.accessToken,
    hasRefreshToken: !!auth?.refreshToken,
    uid: auth?.uid ?? null,
    expiresAt: auth?.expiresAt ?? null,
  });

  if (!auth) {
    throw new Error("TTLockAuth not configured for this organization");
  }

  const now = Date.now();
  const expiresAtMs = auth.expiresAt ? new Date(auth.expiresAt).getTime() : 0;

  const stillValid =
    !!auth.accessToken &&
    !!auth.expiresAt &&
    expiresAtMs > now + 5 * 60 * 1000;

  if (stillValid) {
    return auth.accessToken as string;
  }

  if (!auth.refreshToken) {
    throw new Error("TTLockAuth refreshToken missing for this organization");
  }

  console.log("TTLOCK refreshing access token…");

  const refreshed = await ttlockRefreshAccessToken({
    refreshToken: auth.refreshToken,
  });

  await prisma.tTLockAuth.update({
    where: { organizationId },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? auth.refreshToken,
      uid: refreshed.uid ?? auth.uid ?? null,
      expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
    },
  });

  return refreshed.access_token;
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

  if (!grant.lock?.propertyId) {
    throw new Error("Grant lock missing propertyId");
  }

  console.log("TTLOCK ACTIVATE DEBUG", {
    grantId: grant.id,
    reservationId: grant.reservationId,
    lockId: grant.lock.ttlockLockId,
    propertyId: grant.lock.propertyId,
    method: grant.method,
  });

  const accessToken = await resolveGrantAccessToken(grant.lock.propertyId);

  let nfcResult: any = null;

  if (grant.method === AccessMethod.NFC_TIMEBOUND) {
    const cardId = toIntOrNull(grant.ttlockRefId);

    if (!cardId) {
      throw new Error("NFC_TIMEBOUND grant missing numeric ttlockRefId (cardId)");
    }

    nfcResult = await ttlockChangeCardPeriod({
      accessToken,
      lockId: Number(grant.lock.ttlockLockId),
      cardId,
      startDate: grant.startsAt.getTime(),
      endDate: grant.endsAt.getTime(),
      changeType: 2,
    });
  }

  let keyboardPwdId: number | null = null;
  let code: string | null = null;
  let otpPayload: any = null;

  if (grant.method === AccessMethod.PASSCODE_TIMEBOUND) {
    const pass = await ttlockGetPasscode({
      accessToken,
      lockId: Number(grant.lock.ttlockLockId),
      keyboardPwdType: 1,
      name: grant.reservation?.guestName
        ? `PinGo ${String(grant.reservation.guestName).slice(0, 20)}`
        : "PinGo Guest",
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
        },
      });

      return { ok: false, reason: "No OTP returned" };
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
        activatedAt: Date.now(),
        otp: otpPayload ?? null,
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

  if (!grant.lock?.propertyId) {
    throw new Error("Grant lock missing propertyId");
  }

  const accessToken = await resolveGrantAccessToken(grant.lock.propertyId);

  let nfcResult: any = null;

  if (grant.method === AccessMethod.NFC_TIMEBOUND) {
    const cardId = toIntOrNull(grant.ttlockRefId);

    if (!cardId) {
      throw new Error("NFC_TIMEBOUND grant missing numeric ttlockRefId");
    }

    const now = Date.now();

    nfcResult = await ttlockChangeCardPeriod({
      accessToken,
      lockId: Number(grant.lock.ttlockLockId),
      cardId,
      startDate: now,
      endDate: now,
      changeType: 2,
    });
  }

  if (grant.method === AccessMethod.PASSCODE_TIMEBOUND && grant.ttlockKeyboardPwdId) {
    try {
      await ttlockDeletePasscode({
        accessToken,
        lockId: Number(grant.lock.ttlockLockId),
        keyboardPwdId: Number(grant.ttlockKeyboardPwdId),
        deleteType: 2,
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
        revokedAt: Date.now(),
        nfc: nfcResult,
      },
    },
  });

  return { ok: true };
}