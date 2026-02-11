import { AccessMethod } from "@prisma/client";
// import { ttlockPost } from "../integrations/ttlock/ttlock.client";

function phoneToPasscode(phone?: string) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-7) : null;
}

function maskPasscode(code: string) {
  if (code.length <= 2) return "**";
  return `${code.slice(0, 1)}***${code.slice(-1)}`;
}

function generatePasscode(len = 7) {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// ✅ EXPORT NOMBRADO (esto es lo que te falta)

export async function activateGrant(grant: any, guestPhone?: string) {
  if (grant.method !== AccessMethod.PASSCODE_TIMEBOUND) return {};

  if (!grant?.lock?.ttlockLockId) {
    throw new Error("Lock.ttlockLockId missing on grant.lock");
  }

  const startMs = new Date(grant.startsAt).getTime();
  const endMs = new Date(grant.endsAt).getTime();

  const passcode = phoneToPasscode(guestPhone) ?? generatePasscode(7);

  const resp = await ttlockPost<any>("/v3/keyboardPwd/add", {
    lockId: grant.lock.ttlockLockId,
    keyboardPwd: passcode,
    startDate: startMs,
    endDate: endMs,
    addType: Number(process.env.TTLOCK_ADD_TYPE ?? 2),
    date: Date.now(),
  });

  const keyboardPwdId = resp?.keyboardPwdId ?? resp?.id;
  if (!keyboardPwdId) {
    throw new Error(`TTLock add did not return keyboardPwdId. Resp=${JSON.stringify(resp)}`);
  }

  return {
    ttlockKeyboardPwdId: Number(keyboardPwdId),
    ttlockPayload: resp,
    accessCodeMasked: maskPasscode(passcode),
    unlockKey: "#",
    _passcodePlain: passcode,
  };
}

// ✅ EXPORT NOMBRADO (esto también)
export async function deactivateGrant(grant: any) {
  if (grant.method !== AccessMethod.PASSCODE_TIMEBOUND) return true;

  if (!grant?.lock?.ttlockLockId) {
    throw new Error("Lock.ttlockLockId missing on grant.lock");
  }

  if (!grant.ttlockKeyboardPwdId) {
    throw new Error("ttlockKeyboardPwdId missing for PASSCODE_TIMEBOUND");
  }

  await ttlockPost<any>("/v3/keyboardPwd/delete", {
    lockId: grant.lock.ttlockLockId,
    keyboardPwdId: grant.ttlockKeyboardPwdId,
    deleteType: Number(process.env.TTLOCK_DELETE_TYPE ?? 2),
    date: Date.now(),
  });

  return true;
}
