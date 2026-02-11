// src/integrations/ttlock/ttlock.passcode.ts

import { prisma } from "../../lib/prisma";
import { getTTLockClientForOrg } from "./ttlock.auth";

function phoneToPasscode(phone?: string) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-7) : null;
}

function generatePasscode(len = 7) {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

export async function ttlockCreatePasscode(args: {
  ttlockLockId: number;
  start: Date;
  end: Date;
  phone?: string;
  organizationId: string;
}) {
  const client = await getTTLockClientForOrg(args.organizationId);
  const passcode = phoneToPasscode(args.phone) ?? generatePasscode(7);

  const resp = await client.createCustomPasscode({
    lockId: args.ttlockLockId,
    passcode,
    startDate: args.start.getTime(),
    endDate: args.end.getTime(),
    addType: 2,
  });

  // TTLock suele devolver keyboardPwdId en resp.data
  const keyboardPwdId = Number((resp as any)?.data?.keyboardPwdId);

  if (!keyboardPwdId || Number.isNaN(keyboardPwdId)) {
    throw new Error(`TTLock did not return keyboardPwdId. data=${JSON.stringify((resp as any)?.data)}`);
  }

  return { passcodeId: keyboardPwdId, keyboardPwd: passcode };
}

export async function ttlockDeletePasscode(args: {
  ttlockLockId: number;
  passcodeId: number;
  organizationId: string;
}) {
  const client = await getTTLockClientForOrg(args.organizationId);

  const resp = await client.deletePasscode({
    lockId: args.ttlockLockId,
    keyboardPwdId: args.passcodeId,
  });

  return (resp as any)?.data ?? resp;
}
