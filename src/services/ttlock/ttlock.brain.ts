import { prisma } from "../../lib/prisma";
import { AccessMethod, AccessStatus } from "@prisma/client";
import { ttlockGetPasscode, ttlockDeletePasscode } from "../../ttlock/ttlock.passcode";
import { ttlockChangeCardPeriod } from "../../ttlock/ttlock.card";
import { assignNfcCards } from "../nfc.service";

function phoneTo7Digits(phone?: string | null) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-7) : null;
}


function maskCode(code: string) {
  if (code.length <= 2) return "**";
  return `${code.slice(0, 2)}*****`;
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

  // Idempotencia
  if (grant.status !== AccessStatus.PENDING) {
    return { skipped: true, reason: `Grant not pending (${grant.status})` };
  }

  if (!grant.lock?.ttlockLockId) {
    throw new Error("Grant has no TTLock lock assigned");
  }

  // 💳 NFC (TIMEBOUND) — usamos ttlockRefId como cardId (string -> number)
  // Regla: ttlockRefId debe contener el cardId numérico de TTLock (si no, no activamos NFC)
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
      changeType: 2, // gateway
    });
  }

  // 🔐 PASSCODE (OTP one-time) — tu método estable que abre
  let keyboardPwdId: number | null = null;
  let code: string | null = null;
  let otpPayload: any = null;

if (grant.method === AccessMethod.PASSCODE_TIMEBOUND) {
  const pass = await ttlockGetPasscode({
    lockId: Number(grant.lock.ttlockLockId),
    keyboardPwdType: 1, // OTP one-time
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
        ttlockPayload: {
          ...(grant.ttlockPayload as any),
          activatedAt: Date.now(),
          otp: otpPayload,
          nfc: nfcResult,
        },
      },
    });

    return { ok: false, reason: "No OTP returned" };
  }
}

  // ✅ Update DB
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
   otp: otpPayload ? { keyboardPwdId: keyboardPwdId, raw: otpPayload } : null,
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

  // Idempotencia
  if (grant.status !== AccessStatus.ACTIVE) {
    return { skipped: true, reason: `Grant not active (${grant.status})` };
  }

  if (!grant.lock?.ttlockLockId) {
    throw new Error("Grant has no TTLock lock assigned");
  }

  // 💳 NFC revoke por periodo (NO borrar)
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
    });
  }

// 🔐 Delete passcode (best-effort)
// Si TTLock responde -3 (Invalid Parameter), NO bloqueamos el flujo: seguimos y marcamos REVOKED.
if (grant.method === AccessMethod.PASSCODE_TIMEBOUND && grant.ttlockKeyboardPwdId) {
  try {
    await ttlockDeletePasscode({
      lockId: Number(grant.lock.ttlockLockId),
      keyboardPwdId: Number(grant.ttlockKeyboardPwdId),
      deleteType: Number(process.env.TTLOCK_DELETE_TYPE ?? 2),
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    // -3 => TTLock no acepta borrar ese pwd (OTP viejo / mismatch / parámetro inválido).
    // Lo ignoramos para que checkout no se quede pegado.
    if (msg.includes("errcode=-3")) {
      // opcional: log
      // console.log("[ttlock] delete skipped (-3)", { grantId: grant.id, keyboardPwdId: grant.ttlockKeyboardPwdId });
    } else {
      // otros errores sí los dejamos fallar para reintento
      throw e;
    }
  }
}

  // 🔐 PASSCODE (CUSTOM 7 dígitos)

  // (Si luego implementas CUSTOM timebound passcodes, ahí sí se usa delete con ttlockKeyboardPwdId.)

  // 🚫 Update DB
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
