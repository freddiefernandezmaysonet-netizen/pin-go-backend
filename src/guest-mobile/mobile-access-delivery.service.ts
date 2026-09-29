import type { PrismaClient } from "@prisma/client";
import { decryptMobileLockData } from "./mobile-access-crypto.service.js";

function credentialAad(input: { guestDeviceSessionId: string; accessGrantId: string; lockId: string }) {
  return `mobile-access:v1:${input.guestDeviceSessionId}:${input.accessGrantId}:${input.lockId}`;
}

export async function deliverMobileAccessCredential(
  prisma: PrismaClient,
  input: Readonly<{ credentialId: string; guestDeviceSessionId: string; now?: Date }>,
) {
  const now = input.now ?? new Date();
  const credential = await prisma.mobileAccessCredential.findFirst({
    where: {
      id: input.credentialId,
      guestDeviceSessionId: input.guestDeviceSessionId,
      status: "ACTIVE",
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    select: {
      id: true,
      guestDeviceSessionId: true,
      accessGrantId: true,
      lockId: true,
      lockDataCiphertext: true,
      lockDataKeyVersion: true,
      lockMac: true,
      startsAt: true,
      endsAt: true,
    },
  });
  if (
    !credential ||
    !credential.lockDataCiphertext ||
    !credential.lockDataKeyVersion ||
    !credential.lockMac
  ) throw new Error("MOBILE_ACCESS_CREDENTIAL_NOT_DELIVERABLE");

  const lockData = decryptMobileLockData(
    credential.lockDataCiphertext,
    credential.lockDataKeyVersion,
    credentialAad(credential),
  );

  await prisma.mobileAccessCredential.update({
    where: { id: credential.id },
    data: { lastDeliveredAt: now },
  });

  return {
    version: 1 as const,
    credentialId: credential.id,
    lockData,
    lockMac: credential.lockMac,
    startsAt: credential.startsAt.toISOString(),
    endsAt: credential.endsAt.toISOString(),
  };
}
