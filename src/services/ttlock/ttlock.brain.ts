import {
  AccessGrantType,
  AccessMethod,
  AccessStatus,
 } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import {
  ttlockDeletePasscode,
  ttlockGetPasscode,
} from "../../ttlock/ttlock.passcode";
import { getOrgTtlockAccessToken } from "./ttlock.org-auth";
import { assertGuestAccessReady } from "../guest-access-readiness.service";
import {
  assertAccessCodeEncryptionConfigured,
  encryptAccessCode,
  hashAccessCode,
} from "../access-code-crypto.service";

function maskCode(code: string) {
  if (code.length <= 2) return "**";
  return `${code.slice(0, 2)}*****`;
}

async function resolveGrantAccessToken(propertyId?: string | null) {
  if (!propertyId) {
    throw new Error("TTLOCK_PROPERTY_ID_MISSING");
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { organizationId: true },
  });

  if (!property?.organizationId) {
    throw new Error("TTLOCK_ORGANIZATION_ID_MISSING");
  }

  return getOrgTtlockAccessToken(
    prisma,
    property.organizationId
  );
}

export async function activateGrant(grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    include: {
      lock: true,
      reservation: true,
    },
  });

  if (!grant) {
    throw new Error("ACCESS_GRANT_NOT_FOUND");
  }

  if (grant.status !== AccessStatus.PENDING) {
    return {
      skipped: true,
      reason: `GRANT_NOT_PENDING:${grant.status}`,
    };
  }

  if (
    grant.type !== AccessGrantType.GUEST ||
    grant.method !== AccessMethod.PASSCODE_TIMEBOUND
  ) {
    throw new Error(
      `UNSUPPORTED_ACCESS_GRANT:${grant.type}:${grant.method}`
    );
  }

  if (!grant.reservation) {
    throw new Error("GUEST_ACCESS_RESERVATION_MISSING");
  }

  if (!grant.lock?.ttlockLockId) {
    throw new Error("GUEST_ACCESS_TTLOCK_LOCK_MISSING");
  }

  await assertGuestAccessReady(
  prisma,
  grant.reservation.id
);

  if (grant.ttlockKeyboardPwdId) {
    throw new Error(
      "GUEST_PASSCODE_ID_ALREADY_EXISTS_REQUIRES_RECONCILIATION"
    );
  }

  const startDate = grant.startsAt.getTime();
  const endDate = grant.endsAt.getTime();

  if (
    !Number.isFinite(startDate) ||
    !Number.isFinite(endDate) ||
    endDate <= startDate
  ) {
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.FAILED,
        lastError: "INVALID_GUEST_PASSCODE_WINDOW",
      },
    });

    return {
      ok: false,
      reason: "INVALID_GUEST_PASSCODE_WINDOW",
    };
  }

assertAccessCodeEncryptionConfigured();

  const accessToken = await resolveGrantAccessToken(
    grant.lock.propertyId
  );

  const passcodeName = grant.reservation.reservationNumber
    ? `PinGo ${grant.reservation.reservationNumber}`.slice(0, 30)
    : "PinGo Guest";

  const pass = await ttlockGetPasscode({
    lockId: Number(grant.lock.ttlockLockId),
    keyboardPwdType: 3,
    startDate,
    endDate,
    name: passcodeName,
    accessToken,
  });

  const code = String(pass?.keyboardPwd ?? "").trim();
  const keyboardPwdId = Number(pass?.keyboardPwdId);

  if (
    !code ||
    !Number.isFinite(keyboardPwdId) ||
    keyboardPwdId <= 0
  ) {
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.FAILED,
        lastError:
          "TTLOCK_PERIOD_PASSCODE_RESPONSE_INCOMPLETE",
      },
    });

    return {
      ok: false,
      reason:
        "TTLOCK_PERIOD_PASSCODE_RESPONSE_INCOMPLETE",
    };
  }

 const accessCodeMasked =
    maskCode(code);
  const accessCodeHash =
    hashAccessCode(code);
  const accessCodeEnc =
    encryptAccessCode(code);
  const provisionedAt =
    new Date();

    try {
    await prisma.$transaction([
      prisma.accessGrant.update({
        where: {
          id: grant.id,
        },
        data: {
          status: AccessStatus.ACTIVE,
          ttlockKeyboardPwdId:
            keyboardPwdId,
          accessCodeMasked,
          lastError: null,
          desiredStartsAt:
            grant.startsAt,
          desiredEndsAt:
            grant.endsAt,
          lastAppliedAt:
            provisionedAt,
          ttlockPayload: {
            ...(grant.ttlockPayload as any),
            passcode: {
              provider: "TTLOCK",
              keyboardPwdId,
              keyboardPwdType: 3,
              startsAt:
                grant.startsAt.toISOString(),
              endsAt:
                grant.endsAt.toISOString(),
              provisionedAt:
                provisionedAt.toISOString(),
            },
          },
        },
      }),

      prisma.accessCode.upsert({
        where: {
          accessGrantId: grant.id,
        },
        create: {
          accessGrantId: grant.id,
          lockId: Number(
            grant.lock.ttlockLockId
          ),
          method: "period",
          keyboardPwdId:
            String(keyboardPwdId),
          startDate: BigInt(startDate),
          endDate: BigInt(endDate),
          phone:
            grant.reservation.guestPhone ??
            null,
          accessCodeEnc,
          accessCodeHash,
          accessCodeMasked,
          expiresAt: grant.endsAt,
        },
        update: {
          lockId: Number(
            grant.lock.ttlockLockId
          ),
          method: "period",
          keyboardPwdId:
            String(keyboardPwdId),
          startDate: BigInt(startDate),
          endDate: BigInt(endDate),
          phone:
            grant.reservation.guestPhone ??
            null,
          accessCodeEnc,
          accessCodeHash,
          accessCodeMasked,
          expiresAt: grant.endsAt,
        },
      }),
    ]);
  } catch (persistenceError) {
    try {
      await ttlockDeletePasscode({
        lockId: Number(
          grant.lock.ttlockLockId
        ),
        keyboardPwdId,
        deleteType: Number(
          process.env.TTLOCK_DELETE_TYPE ?? 2
        ) as 1 | 2 | 3,
        accessToken,
      });
    } catch (cleanupError) {
      console.error(
        "[GUEST_ACCESS][ORPHAN_PASSCODE_CLEANUP_FAILED]",
        {
          grantId: grant.id,
          keyboardPwdId,
          persistenceError:
            persistenceError instanceof Error
              ? persistenceError.message
              : String(persistenceError),
          cleanupError:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        }
      );
    }

    throw persistenceError;
  }
  return {
    ok: true,
    passcodePlain: code,
    keyboardPwdId,
    keyboardPwdType: 3 as const,
  };
}

export async function deactivateGrant(grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    include: {
      lock: true,
    },
  });

  if (!grant) {
    throw new Error("ACCESS_GRANT_NOT_FOUND");
  }

  if (grant.status !== AccessStatus.ACTIVE) {
    return {
      skipped: true,
      reason: `GRANT_NOT_ACTIVE:${grant.status}`,
    };
  }

  if (!grant.lock?.ttlockLockId) {
    throw new Error("GUEST_ACCESS_TTLOCK_LOCK_MISSING");
  }

  if (
    grant.method === AccessMethod.PASSCODE_TIMEBOUND &&
    grant.ttlockKeyboardPwdId
  ) {
    const accessToken = await resolveGrantAccessToken(
      grant.lock.propertyId
    );

    await ttlockDeletePasscode({
      lockId: Number(grant.lock.ttlockLockId),
      keyboardPwdId: Number(grant.ttlockKeyboardPwdId),
      deleteType: Number(
        process.env.TTLOCK_DELETE_TYPE ?? 2
      ) as 1 | 2 | 3,
      accessToken,
    });
  }

  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: {
      status: AccessStatus.REVOKED,
      lastError: null,
      ttlockPayload: {
        ...(grant.ttlockPayload as any),
        revokedAt: new Date().toISOString(),
      },
    },
  });

  return { ok: true };
}