import type { PrismaClient } from "@prisma/client";
import { encryptMobileLockData } from "./mobile-access-crypto.service.js";
import { resolveMobileAccessEligibility } from "./mobile-access-eligibility.service.js";
import type { MobileAccessProvider } from "./mobile-access-provider.js";

function credentialAad(input: {
  guestDeviceSessionId: string;
  accessGrantId: string;
  lockId: string;
}) {
  return `mobile-access:v1:${input.guestDeviceSessionId}:${input.accessGrantId}:${input.lockId}`;
}

export async function provisionMobileAccessCredential(
  prisma: PrismaClient,
  provider: MobileAccessProvider,
  input: Readonly<{
    guestDeviceSessionId: string;
    reservationId: string;
    recipient: string;
    now?: Date;
  }>,
) {
  const scope = await resolveMobileAccessEligibility(prisma, input);

  const existing = await prisma.mobileAccessCredential.findUnique({
    where: {
      guestDeviceSessionId_accessGrantId: {
        guestDeviceSessionId: scope.guestDeviceSessionId,
        accessGrantId: scope.accessGrantId,
      },
    },
  });

  if (
    existing?.status === "ACTIVE" &&
    existing.endsAt > (input.now ?? new Date()) &&
    existing.lockDataCiphertext &&
    existing.lockDataKeyVersion &&
    existing.lockMac &&
    existing.providerKeyId
  ) {
    return { credentialId: existing.id, reused: true as const };
  }

  const row = existing ?? await prisma.mobileAccessCredential.create({
    data: {
      guestPersonId: scope.guestPersonId,
      guestDeviceSessionId: scope.guestDeviceSessionId,
      reservationId: scope.reservationId,
      accessGrantId: scope.accessGrantId,
      lockId: scope.lockId,
      startsAt: scope.startsAt,
      endsAt: scope.endsAt,
      status: "PENDING",
    },
  });

  let issued: Awaited<ReturnType<MobileAccessProvider["issueTimeboundKey"]>> | null = null;
  try {
    issued = await provider.issueTimeboundKey({
      providerLockId: scope.providerLockId,
      recipient: input.recipient,
      startsAt: scope.startsAt,
      endsAt: scope.endsAt,
    });

    if (
      !issued.providerKeyId ||
      !issued.lockData ||
      !issued.lockMac ||
      issued.startsAt.getTime() !== scope.startsAt.getTime() ||
      issued.endsAt.getTime() !== scope.endsAt.getTime()
    ) {
      throw new Error("MOBILE_ACCESS_PROVIDER_CREDENTIAL_INVALID");
    }

    const encrypted = encryptMobileLockData(
      issued.lockData,
      credentialAad(scope),
    );

    await prisma.mobileAccessCredential.update({
      where: { id: row.id },
      data: {
        providerKeyId: issued.providerKeyId,
        lockDataCiphertext: encrypted.ciphertext,
        lockDataKeyVersion: encrypted.keyVersion,
        lockMac: issued.lockMac,
        startsAt: issued.startsAt,
        endsAt: issued.endsAt,
        status: "ACTIVE",
        issuedAt: input.now ?? new Date(),
        revokedAt: null,
        lastError: null,
      },
    });

    await prisma.tTLockRecipientIdentity.updateMany({\n      where: { guestPersonId: scope.guestPersonId, status: "ACTIVE" },\n      data: { lastActivityAt: input.now ?? new Date() },\n    });\n\n    return { credentialId: row.id, reused: false as const };
  } catch (error) {
    if (issued?.providerKeyId) {
      try {
        await provider.revokeKey({ providerKeyId: issued.providerKeyId, providerLockId: scope.providerLockId });
      } catch {
        // Preserve FAILED state for canonical recovery; never hide the original provisioning failure.
      }
    }
    await prisma.mobileAccessCredential.update({
      where: { id: row.id },
      data: {
        status: "FAILED",
        lastError: error instanceof Error ? error.message.slice(0, 500) : "MOBILE_ACCESS_PROVISION_FAILED",
      },
    });
    throw error;
  }
}
